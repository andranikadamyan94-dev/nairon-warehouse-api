import { BadRequestException } from '@nestjs/common';
import { MAX_FILE_NAME_LENGTH, renamedFileName } from './file-rename';

describe('renamedFileName — a rename changes the label, never the format', () => {
  it('keeps the stored extension whatever the user typed', () => {
    expect(renamedFileName('report.pdf', 'Annual report')).toBe('Annual report.pdf');
    expect(renamedFileName('report.pdf', 'Annual report.pdf')).toBe('Annual report.pdf');
    expect(renamedFileName('report.pdf', 'Annual report.PDF')).toBe('Annual report.pdf');
    expect(renamedFileName('report.pdf', 'evil.exe')).toBe('evil.exe.pdf');
  });

  it('accepts files without an extension as typed', () => {
    expect(renamedFileName('README', 'Notes')).toBe('Notes');
  });

  it('trims and strips path separators / control characters', () => {
    expect(renamedFileName('a.xlsx', '  ../../etc/passwd  ')).toBe('....etcpasswd.xlsx');
  });

  it('refuses empty and over-long names', () => {
    expect(() => renamedFileName('a.pdf', '   ')).toThrow(BadRequestException);
    expect(() => renamedFileName('a.pdf', '.pdf')).toThrow(BadRequestException);
    expect(() => renamedFileName('a.pdf', 42)).toThrow(BadRequestException);
    expect(() => renamedFileName('a.pdf', 'x'.repeat(MAX_FILE_NAME_LENGTH))).toThrow(BadRequestException);
  });
});
