/**
 * Nextcloud Attachments — sidecar-less.
 *
 * v2 status: improved. The composer-toolbar slot now has full api access
 * (api.http.fetch, api.toast, api.storage). It opens a file picker, uploads
 * each file directly to the user's Nextcloud over WebDAV, generates a
 * public share link, and stages the link in plugin storage. The
 * `onTransformOutgoingEmail` hook (background iframe) reads the staged
 * links on send and appends them to the outgoing message body.
 *
 * Caveats vs. the pre-sandbox plugin:
 *   - Slot iframe and background iframe share storage but not in-memory
 *     state, so the "pending link" list is keyed by a per-composer id that
 *     the slot mints on mount. The hook merges every entry written since
 *     activate() into the next outgoing message and clears the namespace
 *     afterwards. That means a slot that didn't lead to a send leaks its
 *     entries into the next send; the user can clear them via the "Clear"
 *     button or by reloading the app.
 *   - The "appended HTML block" matches v0 styling but is rebuilt
 *     server-side; no cross-iframe DOM mutation is required.
 *   - Nextcloud must be reachable from the user's browser and serve CORS
 *     headers permitting this webmail's null-origin slot iframe (or, more
 *     realistically, allow the host origin — api.http.fetch routes through
 *     the host and uses the host's network identity).
 */

const { createElement: h, useEffect, useState, useCallback } = require('react');
const slotApi = require('@plugin-host');

const STORAGE_KEY = 'pendingLinks'; // [{ id, name, url, password? }]

// ─── Helpers (shared by slot + hook) ──────────────────────────

function joinPath(base, segment) {
  const b = String(base || '').replace(/\/+$/, '');
  const s = String(segment || '').replace(/^\/+/, '');
  if (!b) return '/' + s;
  return b + '/' + s;
}

function trimSlashes(value) {
  return String(value || '').replace(/^\/+|\/+$/g, '');
}

function sanitiseFilename(name) {
  return String(name || 'file').replace(/[\\/:*?"<>|\r\n]+/g, '_').slice(0, 200);
}

function todayFolder() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function shortHash(input) {
  let h = 0;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) - h + input.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36);
}

function randomPassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < 16; i++) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

function buildBlockHtml(links) {
  if (!Array.isArray(links) || links.length === 0) return '';
  const rows = links
    .map((l) => {
      const safeName = String(l.name || 'attachment').replace(/[<>]/g, '');
      const safeUrl = String(l.url || '').replace(/[<>"]/g, '');
      const pwd = l.password
        ? ` &middot; password: <code>${String(l.password).replace(/[<>]/g, '')}</code>`
        : '';
      return `<li><a href="${safeUrl}" rel="noopener noreferrer">${safeName}</a>${pwd}</li>`;
    })
    .join('');
  return (
    '<div style="margin-top:12px;padding:10px;border-top:1px solid #e2e8f0;font-size:13px;color:#475569;">' +
    '<div style="font-weight:600;margin-bottom:4px;">Nextcloud attachments</div>' +
    `<ul style="margin:0;padding-left:20px;">${rows}</ul>` +
    '</div>'
  );
}

function buildBlockText(links) {
  if (!Array.isArray(links) || links.length === 0) return '';
  const lines = links.map((l) => {
    const pwd = l.password ? ` (password: ${l.password})` : '';
    return `- ${l.name || 'attachment'}: ${l.url}${pwd}`;
  });
  return '\n\nNextcloud attachments:\n' + lines.join('\n');
}

// ─── Slot: composer-toolbar button + pending-link list ────────

function NextcloudButton() {
  const [pending, setPending] = useState([]);
  const [busy, setBusy] = useState(false);
  const [hasCreds, setHasCreds] = useState(true);

  const refresh = useCallback(async () => {
    const stored = (await slotApi.storage.get(STORAGE_KEY)) || [];
    setPending(Array.isArray(stored) ? stored : []);
  }, []);

  useEffect(() => {
    void refresh();
    const settings = slotApi.plugin?.settings || {};
    setHasCreds(Boolean(settings.ncUrl && settings.ncUsername && settings.ncAppPassword));
  }, [refresh]);

  async function uploadOne(file) {
    const settings = slotApi.plugin?.settings || {};
    const ncUrl = String(settings.ncUrl || '').replace(/\/+$/, '');
    const ncUsername = String(settings.ncUsername || '');
    const ncAppPassword = String(settings.ncAppPassword || '');
    const baseFolder = trimSlashes(settings.ncBaseFolder || 'Mail attachments');
    const layout = String(settings.ncFolderLayout || 'date');
    const expiryDays = Number(settings.expiryDays) || 0;
    const passwordProtect = settings.passwordProtect === true;

    if (!ncUrl || !ncUsername || !ncAppPassword) {
      throw new Error('Nextcloud credentials are not configured');
    }

    const safeName = sanitiseFilename(file.name);
    let subfolder = '';
    if (layout === 'date') subfolder = todayFolder();
    else if (layout === 'hash') subfolder = shortHash(`${file.name}|${file.size}|${Date.now()}`);
    const remoteFolder = subfolder
      ? trimSlashes(`${baseFolder}/${subfolder}`)
      : baseFolder;
    const remotePath = `${remoteFolder}/${safeName}`;
    const davBase = `${ncUrl}/remote.php/dav/files/${encodeURIComponent(ncUsername)}`;
    const auth = 'Basic ' + btoa(`${ncUsername}:${ncAppPassword}`);

    // 1. Ensure folder hierarchy exists. MKCOL ignores 405 (already exists).
    const parts = remoteFolder.split('/').filter(Boolean);
    let acc = '';
    for (const part of parts) {
      acc += '/' + part;
      const r = await slotApi.http.fetch(`${davBase}${acc}`, {
        method: 'MKCOL',
        headers: { Authorization: auth },
      });
      if (!r.ok && r.status !== 405) {
        throw new Error(`Could not create folder ${acc} (HTTP ${r.status})`);
      }
    }

    // 2. PUT the file. We need binary body — api.http.fetch accepts a
    //    blob/ArrayBuffer.
    const body = file; // File is a Blob; structured-cloneable.
    const putRes = await slotApi.http.fetch(`${davBase}/${remotePath}`, {
      method: 'PUT',
      headers: {
        Authorization: auth,
        'Content-Type': file.type || 'application/octet-stream',
      },
      body,
    });
    if (!putRes.ok) {
      throw new Error(`Upload failed (HTTP ${putRes.status})`);
    }

    // 3. Create the public share. OCS endpoint returns XML by default;
    //    request JSON.
    const sharePassword = passwordProtect ? randomPassword() : '';
    const form = new URLSearchParams();
    form.set('path', '/' + remotePath);
    form.set('shareType', '3'); // public link
    form.set('permissions', '1'); // read-only
    if (sharePassword) form.set('password', sharePassword);
    if (expiryDays > 0) {
      const exp = new Date(Date.now() + expiryDays * 86400_000);
      form.set('expireDate', exp.toISOString().slice(0, 10));
    }
    const shareRes = await slotApi.http.fetch(
      `${ncUrl}/ocs/v2.php/apps/files_sharing/api/v1/shares?format=json`,
      {
        method: 'POST',
        headers: {
          Authorization: auth,
          'OCS-APIRequest': 'true',
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: form.toString(),
      },
    );
    if (!shareRes.ok) {
      throw new Error(`Share creation failed (HTTP ${shareRes.status})`);
    }
    const shareJson = await shareRes.json();
    const shareUrl =
      shareJson?.ocs?.data?.url ||
      shareJson?.ocs?.data?.share_url ||
      '';
    if (!shareUrl) {
      throw new Error('Nextcloud did not return a share URL');
    }
    return {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: file.name,
      url: shareUrl,
      password: sharePassword,
    };
  }

  async function pickAndUpload() {
    if (busy) return;
    if (!hasCreds) {
      await slotApi.ui.alert({
        title: 'Nextcloud not configured',
        message:
          'Open Settings → Plugins → Nextcloud Attachments and enter your server URL, username and app password.',
      });
      return;
    }
    // Native file picker (works inside the slot iframe's own DOM).
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.style.display = 'none';
    document.body.appendChild(input);
    const fileList = await new Promise((resolve) => {
      input.onchange = () => resolve(Array.from(input.files || []));
      input.oncancel = () => resolve([]);
      input.click();
    });
    document.body.removeChild(input);
    if (fileList.length === 0) return;

    setBusy(true);
    try {
      const next = [];
      for (const f of fileList) {
        try {
          const entry = await uploadOne(f);
          next.push(entry);
          slotApi.toast.success(`Uploaded "${f.name}" to Nextcloud`);
        } catch (err) {
          const message = err && err.message ? err.message : String(err);
          slotApi.toast.error(`"${f.name}" failed: ${message}`);
        }
      }
      if (next.length > 0) {
        const merged = [...pending, ...next];
        await slotApi.storage.set(STORAGE_KEY, merged);
        setPending(merged);
      }
    } finally {
      setBusy(false);
    }
  }

  async function clearPending() {
    await slotApi.storage.set(STORAGE_KEY, []);
    setPending([]);
  }

  return h(
    'div',
    { style: { display: 'inline-flex', flexDirection: 'column', gap: '4px' } },
    h(
      'div',
      { style: { display: 'inline-flex', gap: '6px' } },
      h(
        'button',
        {
          type: 'button',
          onClick: pickAndUpload,
          disabled: busy,
          title: hasCreds
            ? 'Upload a file to Nextcloud and attach a share link'
            : 'Configure Nextcloud credentials in Settings → Plugins',
          style: {
            font: 'inherit',
            padding: '6px 10px',
            borderRadius: '6px',
            border: '1px solid #cbd5e1',
            background: '#f8fafc',
            cursor: busy ? 'progress' : 'pointer',
          },
        },
        busy ? 'Uploading…' : '☁ Nextcloud',
      ),
      pending.length > 0
        ? h(
            'button',
            {
              type: 'button',
              onClick: clearPending,
              title: 'Forget the staged Nextcloud links without sending',
              style: {
                font: 'inherit',
                padding: '6px 10px',
                borderRadius: '6px',
                border: '1px solid #fecaca',
                background: '#fef2f2',
                color: '#b91c1c',
                cursor: 'pointer',
              },
            },
            `Clear (${pending.length})`,
          )
        : null,
    ),
    pending.length > 0
      ? h(
          'div',
          {
            style: {
              fontSize: '11px',
              color: '#475569',
              maxWidth: '320px',
            },
          },
          `${pending.length} link${pending.length === 1 ? '' : 's'} will be appended on send`,
        )
      : null,
  );
}

export const slots = {
  'composer-toolbar': {
    component: NextcloudButton,
    order: 80,
  },
};

// ─── Hooks (background iframe) ───────────────────────────────

let pluginApi = null;

export const hooks = {
  onBeforeAttachmentUpload(info) {
    if (!pluginApi) return;
    const settings = pluginApi.plugin.settings || {};
    if (settings.nudgeOnLargeUpload === false) return;
    const threshold = Number(settings.sizeThreshold) || 10 * 1024 * 1024;
    if (info && typeof info.size === 'number' && info.size > threshold) {
      pluginApi.toast.info(
        `"${info.name}" is large — consider uploading to Nextcloud and pasting a share link instead.`,
      );
    }
  },

  async onTransformOutgoingEmail(outgoing) {
    if (!pluginApi) return outgoing;
    const pending = (await pluginApi.storage.get(STORAGE_KEY)) || [];
    if (!Array.isArray(pending) || pending.length === 0) return outgoing;

    const htmlBlock = buildBlockHtml(pending);
    const textBlock = buildBlockText(pending);

    const next = { ...outgoing };
    next.htmlBody = (outgoing.htmlBody || '') + htmlBlock;
    next.textBody = (outgoing.textBody || '') + textBlock;

    // Consume the pending list so the next message doesn't double-up.
    await pluginApi.storage.set(STORAGE_KEY, []);
    pluginApi.toast.info(
      `Appended ${pending.length} Nextcloud link${pending.length === 1 ? '' : 's'} to outgoing message`,
    );
    return next;
  },
};

export async function activate(api) {
  pluginApi = api;
  api.log.info('Nextcloud Attachments plugin activated');
}
