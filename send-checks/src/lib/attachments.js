/**
 * Attachment rules: file types the admin blocks or allows, by extension and
 * by the type the host read from the file's first bytes (`sniffedType`), and
 * a largest size. The sniffed type catches a renamed file: setup.exe sent
 * as invoice.pdf has the extension pdf but starts like a Windows program.
 */

/** What the host reports for the first bytes of a file, by the extensions that normally carry it. */
const SNIFFED_BY_EXTENSION = {
  'application/x-msdownload': ['exe', 'dll', 'scr', 'com', 'cpl', 'pif', 'sys', 'ocx', 'drv', 'efi'],
  'application/x-executable': ['elf', 'so', 'bin', 'run', 'out'],
  'application/x-mach-binary': ['app', 'dylib', 'macho'],
  'text/x-shellscript': ['sh', 'bash', 'zsh', 'ksh', 'csh', 'command'],
  'application/x-ms-shortcut': ['lnk'],
  'application/vnd.ms-cab-compressed': ['cab'],
  // Java and Android apps: ZIP files the host tells apart by their entries.
  'application/java-archive': ['jar'],
  'application/vnd.android.package-archive': ['apk'],
  // Windows Installer packages are OLE compound files, like old Office files.
  'application/x-ole-storage': ['msi', 'msp', 'mst'],
  'application/x-rar-compressed': ['rar'],
  'application/x-7z-compressed': ['7z'],
  'application/gzip': ['gz', 'tgz'],
  'application/pdf': ['pdf'],
  'application/zip': ['zip'],
};

/** Formats that are ZIP files inside: sniffed as application/zip, but not a .zip. */
const ZIP_CONTAINERS = new Set([
  'zip', 'docx', 'docm', 'xlsx', 'xlsm', 'pptx', 'pptm', 'odt', 'ods', 'odp', 'odg', 'jar', 'apk',
  'epub', 'xpi', 'vsix', 'kmz', 'ipa', 'nupkg', 'whl', '3mf', 'pages', 'numbers', 'key',
]);

/** Sniffed types that run code when opened (or install it). */
const PROGRAM_TYPES = new Set([
  'application/x-msdownload', 'application/x-executable', 'application/x-mach-binary', 'text/x-shellscript',
  'application/x-ms-shortcut', 'application/vnd.ms-cab-compressed', 'application/x-ole-storage',
  'application/java-archive', 'application/vnd.android.package-archive',
]);

/** Old Office and Outlook files: OLE compound files like an installer, but documents. */
const OLE_DOCUMENTS = new Set(['doc', 'dot', 'xls', 'xlt', 'ppt', 'pot', 'pps', 'msg', 'pub', 'vsd', 'mpp']);

/** Extensions of programs: blocking any of them blocks every program, whatever it is named. */
const PROGRAM_EXTENSIONS = new Set(
  Object.entries(SNIFFED_BY_EXTENSION).filter(([type]) => PROGRAM_TYPES.has(type)).flatMap(([, exts]) => exts),
);

/** "exe, .bat; application/x-msdownload image/*" → { extensions, types }. */
export function parseTypeList(value) {
  const extensions = new Set();
  const types = new Set();
  for (const raw of String(value ?? '').split(/[\s,;]+/)) {
    const item = raw.trim().toLowerCase();
    if (!item) continue;
    if (item.includes('/')) types.add(item);
    else extensions.add(item.replace(/^\*?\./, ''));
  }
  return { extensions, types };
}

export function isEmptyList(list) {
  return list.extensions.size === 0 && list.types.size === 0;
}

/** The extensions of a file name, last one last ("invoice.pdf.exe" → ["pdf", "exe"]). */
export function extensionsOf(name) {
  const parts = String(name ?? '').toLowerCase().trim().replace(/[.\s]+$/, '').split('.');
  if (parts.length < 2) return [];
  return parts.slice(1).filter((p) => /^[a-z0-9]{1,10}$/.test(p) && !/^\d+$/.test(p));
}

function typeMatches(type, types) {
  if (!type) return false;
  const t = type.toLowerCase();
  if (types.has(t)) return true;
  const slash = t.indexOf('/');
  return slash > 0 && types.has(`${t.slice(0, slash)}/*`);
}

/** The sniffed types a blocked extension stands for, so "exe" also catches a renamed program. */
function sniffedTypesFor(extensions) {
  const out = new Set();
  for (const [type, exts] of Object.entries(SNIFFED_BY_EXTENSION)) {
    if (exts.some((e) => extensions.has(e))) out.add(type);
  }
  return out;
}

/**
 * Why `file` breaks the type rules, or null. Returns { reason, type }:
 * reason 'blocked' (on the blocked list) or 'not-allowed' (an allowed list
 * is set and it isn't on it); `type` names what matched, for the message.
 */
export function typeProblem(file, blocked, allowed) {
  const exts = extensionsOf(file.name);
  const last = exts[exts.length - 1] ?? '';
  const sniffed = typeof file.sniffedType === 'string' ? file.sniffedType.toLowerCase() : '';
  // A ZIP-based document (docx, odt...) is sniffed as zip, and an old
  // Office file as an OLE compound file like an installer; that says
  // nothing about it being a .zip or a program.
  const sniffedCounts = sniffed
    && !(sniffed === 'application/zip' && ZIP_CONTAINERS.has(last) && last !== 'zip')
    && !(sniffed === 'application/x-ole-storage' && OLE_DOCUMENTS.has(last));
  const declared = typeof file.type === 'string' ? file.type.toLowerCase() : '';
  const blocksPrograms = [...blocked.extensions].some((e) => PROGRAM_EXTENSIONS.has(e));

  if (!isEmptyList(blocked)) {
    if (last && blocked.extensions.has(last)) return { reason: 'blocked', type: last };
    // A double extension: "invoice.pdf.exe" ends in exe, caught above;
    // "report.exe.txt" doesn't run, so only the last one counts.
    if (sniffedCounts && (typeMatches(sniffed, blocked.types) || sniffedTypesFor(blocked.extensions).has(sniffed)
      || (blocksPrograms && PROGRAM_TYPES.has(sniffed)))) {
      return { reason: 'blocked', type: sniffed };
    }
    if (declared && typeMatches(declared, blocked.types)) return { reason: 'blocked', type: declared };
  }

  if (!isEmptyList(allowed)) {
    const byExtension = !!last && allowed.extensions.has(last);
    const byType = typeMatches(declared, allowed.types) || (sniffedCounts && typeMatches(sniffed, allowed.types));
    if (!byExtension && !byType) return { reason: 'not-allowed', type: last || declared || sniffed || '?' };
    // Allowed by its name, but the content is a program: a renamed file.
    if (sniffedCounts && PROGRAM_TYPES.has(sniffed) && !typeMatches(sniffed, allowed.types)
      && !sniffedTypesFor(allowed.extensions).has(sniffed)) {
      return { reason: 'not-allowed', type: sniffed };
    }
  }
  return null;
}

/** Bytes for a size limit in MB; 0 or nonsense means no limit. */
export function maxBytes(maxSizeMb) {
  const n = Number(maxSizeMb);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 1024 * 1024) : 0;
}

/**
 * The attachment problems of a message as [{ name, kind: 'type'|'size', type?, reason? }].
 * Images pasted into the text (inline) are checked for size only: an
 * allowed list of document types shouldn't stop a screenshot.
 */
export function attachmentProblems(attachments, { blocked, allowed, limit }) {
  const out = [];
  for (const file of Array.isArray(attachments) ? attachments : []) {
    if (!file || typeof file !== 'object') continue;
    const name = String(file.name || 'attachment');
    if (!file.inline) {
      const problem = typeProblem(file, blocked, allowed);
      if (problem) out.push({ name, kind: 'type', type: problem.type, reason: problem.reason });
    }
    if (limit > 0 && Number(file.size) > limit) out.push({ name, kind: 'size' });
  }
  return out;
}

/** Attachment types worth reading for the text rules, by MIME type or extension (as the host reads them). */
const TEXT_EXTENSIONS = new Set(['txt', 'csv', 'tsv', 'json', 'xml', 'ics', 'vcf', 'md', 'log', 'html', 'htm', 'yaml', 'yml', 'ini', 'conf']);
const TEXT_TYPES = new Set(['application/json', 'application/xml', 'application/csv', 'application/x-yaml', 'application/yaml']);
export function isTextAttachment(file) {
  // "application/json; charset=utf-8": the parameters don't change the type.
  const type = String(file?.type ?? '').toLowerCase().split(';')[0].trim();
  if (type.startsWith('text/') || TEXT_TYPES.has(type) || /\+(json|xml)$/.test(type)) return true;
  const exts = extensionsOf(file?.name);
  return TEXT_EXTENSIONS.has(exts[exts.length - 1] ?? '');
}
