/**
 * Builds a small, genuinely valid PDF without a PDF library.
 *
 * The repository has no PDF dependency and Phase 1 does not justify adding one for a
 * demonstration fixture. What it does justify is a real file: the whole point of the
 * validation in §8 is that a document which merely claims to be a PDF gets rejected, so a
 * fixture that is not openable would make the demo prove the opposite of what it claims.
 *
 * This writes PDF 1.4 by hand — catalog, pages, one page, a Helvetica font and a content
 * stream — with a correct cross-reference table. It opens in any reader.
 */
export interface SamplePdfLines {
  title: string;
  lines: string[];
}

/** Escapes the three characters that are syntax inside a PDF string literal. */
function pdfEscape(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

export function buildSamplePdf({ title, lines }: SamplePdfLines): Buffer {
  const body: string[] = [];
  body.push('BT', '/F1 18 Tf', '60 760 Td', `(${pdfEscape(title)}) Tj`, 'ET');
  let y = 720;
  for (const line of lines) {
    body.push('BT', '/F1 11 Tf', `60 ${y} Td`, `(${pdfEscape(line)}) Tj`, 'ET');
    y -= 20;
    if (y < 60) break;
  }
  const content = body.join('\n');

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
  ];

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((definition, index) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${index + 1} 0 obj\n${definition}\nendobj\n`;
  });

  const xrefOffset = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  // Every offset is exactly ten digits and every line exactly twenty bytes; a reader seeks by
  // arithmetic on those widths, so a short line silently corrupts the file.
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(pdf, 'latin1');
}
