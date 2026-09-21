import { Fd, File, OpenFile, wasi } from "@bjorn3/browser_wasi_shim";

/**
 * stdin served from memory. A read-only regular file rather than a character
 * device: GHC then treats the handle like redirected-file stdin (no tty probing,
 * seekable, plain read-to-EOF), which is also how native ShellCheck sees `< file`.
 */
export class MemoryInput extends OpenFile {
  constructor(data: Uint8Array) {
    super(new File(data, { readonly: true }));
  }
}

/** stdout or stderr captured in memory; every fd_write chunk is kept in order. */
export class MemoryOutput extends Fd {
  private readonly chunks: Uint8Array[] = [];
  private length = 0;

  override fd_fdstat_get(): { ret: number; fdstat: wasi.Fdstat | null } {
    const fdstat = new wasi.Fdstat(wasi.FILETYPE_CHARACTER_DEVICE, 0);
    fdstat.fs_rights_base = BigInt(wasi.RIGHTS_FD_WRITE);
    return { ret: wasi.ERRNO_SUCCESS, fdstat };
  }

  override fd_fdstat_set_flags(): number {
    return wasi.ERRNO_SUCCESS;
  }

  override fd_filestat_get(): { ret: number; filestat: wasi.Filestat | null } {
    return {
      ret: wasi.ERRNO_SUCCESS,
      filestat: new wasi.Filestat(0n, wasi.FILETYPE_CHARACTER_DEVICE, BigInt(this.length)),
    };
  }

  override fd_write(data: Uint8Array): { ret: number; nwritten: number } {
    // The shim hands us a view into guest memory; copy before the guest reuses it.
    this.chunks.push(data.slice());
    this.length += data.byteLength;
    return { ret: wasi.ERRNO_SUCCESS, nwritten: data.byteLength };
  }

  override fd_seek(): { ret: number; offset: bigint } {
    return { ret: wasi.ERRNO_SPIPE, offset: 0n };
  }

  override fd_tell(): { ret: number; offset: bigint } {
    return { ret: wasi.ERRNO_SPIPE, offset: 0n };
  }

  override fd_read(): { ret: number; data: Uint8Array } {
    return { ret: wasi.ERRNO_BADF, data: new Uint8Array() };
  }

  bytes(): Uint8Array {
    const out = new Uint8Array(this.length);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  }
}
