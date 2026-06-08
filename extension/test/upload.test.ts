import { describe, expect, it } from 'vitest';
import { validatePath } from '../src/tools/upload-path.js';

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
