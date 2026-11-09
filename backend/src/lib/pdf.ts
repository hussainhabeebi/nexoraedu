/**
 * PDFKit for both runtimes. On Cloudflare Workers the browser build of PDFKit is used: it has no file system,
 * so the standard fonts used by the ERP's receipts and certificates (Helvetica, Helvetica-Bold) are registered
 * from bundled data. In Node.js (tests) PDFKit reads them itself.
 */
import * as pdfkit from 'pdfkit';
import Helvetica from 'pdfkit/standard-fonts/Helvetica';
import HelveticaBold from 'pdfkit/standard-fonts/HelveticaBold';

const mod: any = pdfkit;
if (typeof mod.registerStdFonts === 'function') mod.registerStdFonts(Helvetica, HelveticaBold);

const PDFDocument: typeof import('pdfkit') = mod.default?.default ?? mod.default ?? mod.PDFDocument;
export default PDFDocument;
