import { describe, expect, it } from 'vitest';
import { validatePath } from '../src/tools/upload-path.js';
import { classifyUpload, UPLOAD_READBACK_PROBE, UPLOAD_TARGET_PROBE } from '../src/tools/upload.js';

describe('upload.validatePath', () => {
  it('accepts an ordinary absolute POSIX path', () => {
    expect(validatePath('/home/user/Downloads/sallyport/photo.jpg')).toBe(
      '/home/user/Downloads/sallyport/photo.jpg',
    );
  });

  it('accepts a Windows drive-letter path with either slash', () => {
    expect(validatePath('C:\\Users\\u\\Downloads\\a.png')).toBe('C:\\Users\\u\\Downloads\\a.png');
    expect(validatePath('D:/data/file.csv')).toBe('D:/data/file.csv');
  });

  it('rejects relative paths', () => {
    expect(() => validatePath('Downloads/x.jpg')).toThrow(/must be absolute/);
    expect(() => validatePath('./x.jpg')).toThrow(/must be absolute/);
  });

  it('rejects empty / non-string input', () => {
    expect(() => validatePath('')).toThrow(/non-empty string/);
    expect(() => validatePath(null)).toThrow(/non-empty string/);
    expect(() => validatePath(undefined)).toThrow(/non-empty string/);
    expect(() => validatePath(42)).toThrow(/non-empty string/);
  });

  it('rejects any segment that is exactly `..` — POSIX', () => {
    expect(() => validatePath('/home/user/../etc/passwd')).toThrow(/contains '\.\.'/);
  });

  it('rejects `..` segments on Windows-style paths too', () => {
    expect(() => validatePath('C:/Users/u/../../etc/x')).toThrow(/contains '\.\.'/);
    expect(() => validatePath('C:\\Users\\u\\..\\..\\x')).toThrow(/contains '\.\.'/);
  });

  it("accepts a path that merely contains '..' inside a segment", () => {
    // Only exact segment matches are rejected — `foo..bar` is a legal filename.
    expect(validatePath('/tmp/foo..bar.txt')).toBe('/tmp/foo..bar.txt');
  });
});

describe('classifyUpload — did the input actually take the files?', () => {
  it('yes when the element holds exactly what was sent', () => {
    expect(classifyUpload(['/d/sallyport/a.png'], { names: ['a.png'] })).toEqual({
      applied: 'yes',
      accepted: ['a.png'],
    });
  });

  it('no when the page cleared or filtered the selection', () => {
    // setFileInputFiles fires input+change, so a handler that rejects the file
    // (wrong type, too large, a quota) can empty the input in the same tick —
    // and the old result echoed the path it had SENT, so the agent went on to
    // submit a form with nothing attached.
    expect(classifyUpload(['/d/sallyport/a.exe'], { names: [] })).toEqual({
      applied: 'no',
      accepted: [],
    });
  });

  it('no when only some of the files survived', () => {
    const out = classifyUpload(['/d/sallyport/a.png', '/d/sallyport/b.png'], { names: ['a.png'] });
    expect(out).toEqual({ applied: 'no', accepted: ['a.png'] });
  });

  it('compares basenames, not the sandbox path the agent passed', () => {
    expect(classifyUpload(['/very/long/dir/photo.jpg'], { names: ['photo.jpg'] }).applied).toBe(
      'yes',
    );
  });

  it('claims nothing when the node could not be read back', () => {
    // UNVERIFIED, not failed: a re-rendering page replaces the input routinely.
    expect(classifyUpload(['/d/a.png'], null)).toEqual({ applied: 'unclear' });
  });
});

describe('the upload probes are self-contained', () => {
  const target = new Function(`return (${UPLOAD_TARGET_PROBE});`)() as (this: unknown) => {
    tag: string;
    type: string;
    multiple: boolean;
  };
  const readback = new Function(`return (${UPLOAD_READBACK_PROBE});`)() as (
    this: unknown,
  ) => { names: string[] } | null;

  it('reads tag, type and multiple off the element', () => {
    expect(target.call({ tagName: 'INPUT', type: 'FILE', multiple: true })).toEqual({
      tag: 'INPUT',
      type: 'file',
      multiple: true,
    });
    // A styled upload button is the usual mis-target, and it must not read as
    // a file input.
    expect(target.call({ tagName: 'BUTTON' })).toEqual({
      tag: 'BUTTON',
      type: '',
      multiple: false,
    });
  });

  it('reads back file NAMES only, never content', () => {
    const el = { files: [{ name: 'a.png', size: 12 }, { name: 'b.png' }] };
    expect(readback.call(el)).toEqual({ names: ['a.png', 'b.png'] });
  });

  it('answers null for a detached node or an input with no files list', () => {
    expect(readback.call({ isConnected: false, files: [] })).toBeNull();
    expect(readback.call({})).toBeNull();
  });
});
