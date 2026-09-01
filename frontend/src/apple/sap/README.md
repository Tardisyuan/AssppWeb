# Browser-side SAP signing

Apple gated the authenticate endpoint behind a SAP signature in August 2026.
The bag says so directly — `urlBag.sign-sap-request` lists `MZFinance:
authenticate`, `auth/v1: native` and `auth/v1/native: fast` — and every one of
those endpoints now answers an unsigned request with `403` and an empty body,
about 6ms in, before it looks at credentials.

ipatool 2.4.0 solved this by running Apple's own signing code from a 2013 OS X
release under a CPU emulator. This is a port of that approach to the browser,
so the signature is produced client-side and the server keeps knowing nothing
about Apple credentials.

## Where it stands

The signer works, and Apple accepts what it produces. Sending the same
deliberately wrong credentials with and without a signature separates the two
cases cleanly:

```
without signature:  HTTP 403, empty body            rejected at the edge
with signature:     HTTP 200, 326 bytes, a plist    credentials evaluated
                    customerMessage: MZFinance.BadLogin.Configurator_message
```

That second response is the ordinary "wrong password" answer, which is the
point: the request got as far as the credential check. Setup itself completes
against Apple too — the certificate comes from s.mzstatic.com and the setup
buffer round-trips through fpinit.itunes.apple.com, both HTTP 200.

Setup runs about 5.3 million guest instructions for `initialize` and another
5 million for the two exchange rounds, and takes roughly 63 seconds. That is
slow enough to need a Web Worker and a progress indicator, and it is the main
thing left before this is usable in the UI.

Nothing in setup involves credentials. The only identity is the hardware id,
which is the same guid the client already sends in the clear, so the setup can
happen well before anyone types a password.

Still to do: check a signature is actually accepted by `authenticate`, serve
the assets from the backend instead of a local ipatool cache, wire it into
`authenticate.ts`, and find out whether it fits in mobile Safari's memory.

## The block splitter

unicorn.js cannot execute a basic block beyond a certain length. Synthetic
blocks of `nop` and of `mov rax,rcx` both survive 88 instructions and both
trap at 96, despite differing three-fold in bytes, so the limit counts
interpreter operations rather than bytes:

```
TODO .../unicorn/qemu/tcg/tci.c:1272: tcg_qemu_tb_exec_x86_64()
Aborted()
```

WebAssembly cannot emit native code, so this build runs QEMU's Tiny Code
Interpreter rather than the usual JIT, and `tci.c` aborts on an unimplemented
path. The guest is full of blocks over that length — the one `initialize`
calls into is 134 straight-line moves — and the emulator offers no way to
bound them: `uc_ctl` is the one entry point unicorn.js does not export, and it
only sizes the TCG buffer anyway.

So `machine.ts` splits blocks itself. A HLT goes in at a safe boundary, the
guest stops on it, the original byte goes back, and execution resumes from the
same address. Only the translator can tell.

Three things this requires:

**Boundaries.** `length.ts` decodes the x86-64 encoding structure without
caring what any instruction does. objdump cannot supply them: its linear sweep
desyncs on these obfuscated images and reports valid instructions as bad
opcodes, and a HLT planted at a boundary taken from that output manufactures
an invalid opcode — which traps exactly like the bug being chased.

**One block at a time.** Taking a branch also translates its target, so
letting execution chain hands the emulator a block of the guest's choosing.
The target's split has to be planted before the branch runs, which means
resolving the branch first: relative displacements come out of the encoding,
an indirect call through a jump table needs its ModRM and SIB evaluated
against live registers, and a return reads its target off the stack.

**A split must not land on the instruction about to run.** The back edge of a
nine-instruction loop does exactly that whenever the limit is eight.

The limit is 32. Measured over a full setup: 32 works and takes 63s, 48 works
but takes 76s, and 64 traps.

## Layout

| File | Role |
| --- | --- |
| `macho.ts` | Mach-O loader: x86-64 slice, segments, symbols, dyld rebase and bind opcodes |
| `length.ts` | x86-64 length decoder and basic-block measurement |
| `engine.ts` | unicorn.js wrapper, matching ipatool's `internal/sap/unicorn` |
| `shims.ts` | Guest service area, calling convention, heap allocator |
| `platform.ts` | The macOS imports the guest expects: CoreFoundation, IOKit, dlopen, `_read` for CoreFP.icxs |
| `machine.ts` | Loads the images, splits blocks, drives initialize / exchange / sign / teardown |
| `signer.ts` | The setup protocol and the signing entry point |

## Notes for whoever picks this up

Four bugs cost real time, all in the same shape — a length computed one byte
wrong, which plants a HLT mid-instruction, which traps exactly like the
emulator limit:

- Segment offsets are `uint64` in the original and linkers rely on the wrap.
  CoreFP encodes a backward jump of `-0x938` as `ADD_ADDR_ULEB
  0xfffffffffffff6c8`; BigInt has no width, so every offset step masks to 64
  bits.
- `BIND_OPCODE_DONE` means different things per stream: it separates one
  symbol's sequence from the next in a lazy stream, but ends the regular and
  weak streams, which are followed by padding that must not be parsed.
- `SHLD`/`SHRD` by an immediate (`0F A4`, `0F AC`) carry an imm8. The guest's
  obfuscation is full of them.
- `Jcc rel32` (`0F 80`–`0F 8F`) carries no ModRM byte.

The emulator, not objdump, is the ground truth for boundaries: if an executed
address is one the decoder would not have produced, the decoder is wrong.
`Shims.trace`, `Machine.traceInstructions` and `Machine.setUnmappedTrace` are
there for exactly that, since faults arrive without addresses.
