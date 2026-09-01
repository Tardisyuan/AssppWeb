# Browser-side SAP signing

Apple gated the authenticate endpoint behind a SAP signature in August 2026.
The bag says so directly — `urlBag.sign-sap-request` lists `MZFinance:
authenticate`, `auth/v1: native` and `auth/v1/native: fast` — and every one of
those endpoints now answers an unsigned request with `403` and an empty body,
about 6ms in, before it looks at credentials.

ipatool 2.4.0 solved this by running Apple's own signing code from a 2013 OS X
release under a CPU emulator. This directory is a port of that approach to the
browser, so the signature can be produced client-side and the server keeps
knowing nothing about Apple credentials.

## Where it stands

`macho.ts` and the machine layer work. The images load, their symbols resolve
to the same addresses ipatool reports, and the guest executes real code from
them.

**It is blocked on unicorn.js.** The WebAssembly build cannot execute a basic
block longer than about 90 instructions:

```
nop           64✓  70✓  72✓  76✓  80✓  88✓  96✗
mov rax,rcx   64✓  70✓  72✓  76✓  80✓  88✓  96✗

TODO /home/alexandro/Projects/unicorn.js/unicorn/qemu/tcg/tci.c:1272:
     tcg_qemu_tb_exec_x86_64()
Aborted()
```

The two shapes fail at the same instruction count despite differing three-fold
in bytes, so the limit counts instructions rather than block size. WebAssembly
cannot emit native code, so this build runs QEMU's Tiny Code Interpreter
instead of the usual JIT, and `tci.c` aborts on an unimplemented path.

`_fp_dh_53e921020eab5219f8d89c1026b77657`, which `initialize` calls almost
immediately, opens with roughly 130 consecutive moves before its first branch.
That is over the limit, so the module traps. It surfaces as "memory access out
of bounds" with no address, because this build also answers an invalid opcode
or an unmapped access by trapping rather than returning `UC_ERR_*`.

Nothing in this directory can work around it: the limit is in the emulator's
interpreter, below any API. `uc_ctl` would not help either — it only sizes the
TCG buffer, and it is the one entry point unicorn.js does not export.

## Getting past it

Patching `tci.c` and rebuilding the WebAssembly is the only route.
[petabyt/unicorn-wasm](https://github.com/petabyt/unicorn-wasm) already carries
TCI patches for a wasm build and is the obvious place to start, though it
derives from the same unicorn.js patches and may well share the limit — worth
measuring with the same instruction-count sweep before building anything on
it.

Until then, licences are acquired out of band with `ipatool purchase -b
<bundle-id>`; downloads never needed a signature and keep working from the
imported token.

## Layout

| File | Role |
| --- | --- |
| `macho.ts` | Mach-O loader: x86-64 slice, segments, symbols, dyld rebase and bind opcodes |
| `engine.ts` | unicorn.js wrapper, matching ipatool's `internal/sap/unicorn` |
| `shims.ts` | Guest service area, calling convention, heap allocator |
| `platform.ts` | The macOS imports the guest expects: CoreFoundation, IOKit, dlopen, `_read` for CoreFP.icxs |
| `machine.ts` | Loads the images and drives initialize / exchange / sign / teardown |

## Notes for whoever picks this up

Two things in `macho.ts` are easy to get wrong and were both real bugs:

Segment offsets are `uint64` in the original and linkers rely on the wrap.
CoreFP encodes a backward jump of `-0x938` as `ADD_ADDR_ULEB
0xfffffffffffff6c8`; BigInt has no width, so every offset step masks to 64
bits.

`BIND_OPCODE_DONE` means different things per stream. It separates one
symbol's sequence from the next in a lazy stream, but ends the regular and
weak streams, which are followed by padding that must not be parsed.

`Shims.trace`, `Machine.traceInstructions` and `Machine.setUnmappedTrace` are
there for debugging an opaque guest whose emulator reports faults without
addresses. Do not disassemble the images with `objdump` or `otool` to find
instruction boundaries — the linear sweep desyncs on this obfuscated code and
reports `bad opcode` for perfectly valid instructions. Truncating a block at a
boundary taken from that output creates an invalid opcode, which traps exactly
like the bug being chased.
