import i18n from '../i18n';
import { appleRequest } from './request';
import { buildPlist, parsePlist } from './plist';
import { extractAndMergeCookies } from './cookies';
import { purchaseAPIHost } from './config';
import type { Account, Software } from '../types';

export class PurchaseError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'PurchaseError';
  }
}

export interface PurchaseResult {
  updatedCookies: Account['cookies'];
  /** Apple reported the account already holds this license (failureType 5002). */
  alreadyOwned: boolean;
}

export async function purchaseApp(account: Account, app: Software): Promise<PurchaseResult> {
  if ((app.price ?? 0) > 0) {
    throw new PurchaseError(i18n.t('errors.purchase.paidNotSupported'));
  }

  try {
    return await purchaseWithParams(account, app, 'STDQ');
  } catch (e) {
    // Rely on error code instead of translated message string to prevent matching issues
    if (e instanceof PurchaseError && e.code === '2059') {
      return await purchaseWithParams(account, app, 'GAME');
    }
    throw e;
  }
}

async function purchaseWithParams(account: Account, app: Software, pricingParameters: string): Promise<PurchaseResult> {
  const deviceId = account.deviceIdentifier;
  const host = purchaseAPIHost(account.pod);
  const path = '/WebObjects/MZFinance.woa/wa/buyProduct';

  const payload: Record<string, any> = {
    appExtVrsId: '0',
    hasAskedToFulfillPreorder: 'true',
    buyWithoutAuthorization: 'true',
    hasDoneAgeCheck: 'true',
    guid: deviceId,
    needDiv: '0',
    origPage: `Software-${app.id}`,
    origPageLocation: 'Buy',
    price: '0',
    pricingParameters,
    productType: 'C',
    salableAdamId: app.id,
  };

  // buyProduct keys off X-Apple-Store-Front. Apple sends the storefront header
  // on some sign-in responses only, so an account stored before that value was
  // carried forward can hold an empty string — which would send `-1` here and
  // come back as a generic internal error naming nothing.
  if (!account.store) {
    throw new PurchaseError(i18n.t('errors.purchase.missingStorefront'));
  }

  const plistBody = buildPlist(payload);

  const headers: Record<string, string> = {
    'Content-Type': 'application/x-apple-plist',
    'iCloud-DSID': account.directoryServicesIdentifier,
    'X-Dsid': account.directoryServicesIdentifier,
    'X-Apple-Store-Front': `${account.store}-1`,
    'X-Token': account.passwordToken,
  };

  const response = await appleRequest({
    method: 'POST',
    host,
    path,
    headers,
    body: plistBody,
    cookies: account.cookies,
  });

  const updatedCookies = extractAndMergeCookies(response.rawHeaders, account.cookies);

  const dict = parsePlist(response.body) as Record<string, any>;

  if (dict.failureType) {
    const failureType = String(dict.failureType);
    const customerMessage = dict.customerMessage as string | undefined;

    // Apple localizes customerMessage, so the text alone does not identify the
    // failure, and the generic ones say nothing. The response rides the wisp
    // tunnel, so devtools cannot show it either.
    console.warn('[Purchase] buyProduct refused', {
      failureType,
      customerMessage,
      dialog: (dict.dialog as Record<string, any>)?.explanation ?? (dict.dialog as Record<string, any>)?.message,
      status: dict.status,
      jingleDocType: dict.jingleDocType,
      storeFront: headers['X-Apple-Store-Front'],
      pricingParameters,
      host,
    });
    switch (failureType) {
      // buyProduct answers an already-licensed app with 5002 and the generic
      // "An unknown error has occurred"; the license exists, so this succeeds.
      case '5002':
        return { updatedCookies, alreadyOwned: true };
      case '2059':
        throw new PurchaseError(i18n.t('errors.purchase.unavailable'), '2059');
      case '2034':
      case '2042':
        throw new PurchaseError(i18n.t('errors.purchase.passwordExpired'), failureType);
      default: {
        if (customerMessage === 'Your password has changed.') {
          throw new PurchaseError(i18n.t('errors.purchase.passwordExpired'), failureType);
        }
        if (customerMessage === 'Subscription Required') {
          throw new PurchaseError(i18n.t('errors.purchase.subscriptionRequired'), failureType);
        }
        // Check for terms page action
        const action = dict.action as Record<string, any> | undefined;
        if (action) {
          const actionUrl = (action.url || action.URL) as string | undefined;
          if (actionUrl && actionUrl.endsWith('termsPage')) {
            throw new PurchaseError(i18n.t('errors.purchase.termsRequired', { url: actionUrl }), failureType);
          }
        }

        // Handle unknown error specific fallback mappings
        let msg = customerMessage;
        if (msg === 'An unknown error has occurred' || msg === 'An unknown error has occurred.') {
          msg = i18n.t('errors.purchase.unknownError');
        }

        // Apple's own wording, with the code appended: the message is what the
        // user can act on, the code is what a report can be matched against.
        throw new PurchaseError(
          msg
            ? i18n.t('errors.purchase.failedWithMessage', { message: msg, failureType })
            : i18n.t('errors.purchase.failed', { failureType }),
          failureType,
        );
      }
    }
  }

  const jingleDocType = dict.jingleDocType as string | undefined;
  const status = dict.status as number | undefined;

  if (jingleDocType !== 'purchaseSuccess' || status !== 0) {
    console.warn('[Purchase] buyProduct did not report success', {
      jingleDocType,
      status,
      storeFront: headers['X-Apple-Store-Front'],
      pricingParameters,
      host,
    });
    throw new PurchaseError(i18n.t('errors.purchase.failedGeneral'));
  }

  return { updatedCookies, alreadyOwned: false };
}
