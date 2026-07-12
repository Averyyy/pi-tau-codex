import { copyText } from './session-actions.js';

function responseError(data, fallback) {
  const error = new Error(data?.error || data?.message || fallback);
  if (data?.code) error.code = data.code;
  if (data?.fallback) error.fallback = data.fallback;
  return error;
}

async function readJson(response, fallback) {
  const data = await response.json();
  if (!response.ok) throw responseError(data, fallback);
  return data;
}

function importUrl(action, projectPath) {
  const path = `/api/sessions/import/${action}`;
  return projectPath ? `${path}?projectPath=${encodeURIComponent(projectPath)}` : path;
}

export async function inspectSessionImport(file, mutationFetch) {
  const response = await mutationFetch(importUrl('inspect'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-ndjson' },
    body: file,
  });
  return readJson(response, 'Failed to inspect session');
}

export async function installSessionImport(file, projectPath, mutationFetch) {
  const response = await mutationFetch(importUrl('install', projectPath), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-ndjson' },
    body: file,
  });
  return readJson(response, 'Failed to import session');
}

export async function requestImportProjects(fetchImpl = fetch) {
  const response = await fetchImpl('/api/projects');
  return readJson(response, 'Failed to load projects');
}

export function importProjectOptions({ projects = [], taskPath = '' }) {
  const options = projects
    .filter((project) => typeof project?.path === 'string' && project.path)
    .map((project) => ({
      path: project.path,
      label: `${project.name || 'Project'} - ${project.path}`,
    }));
  if (taskPath && !options.some((option) => option.path === taskPath)) {
    options.push({ path: taskPath, label: `No project - ${taskPath}` });
  }
  return options;
}

export async function requestShareCapability(fetchImpl = fetch) {
  const response = await fetchImpl('/api/share/capability');
  return readJson(response, 'Failed to check sharing availability');
}

export async function createSessionShare(sessionFile, mutationFetch) {
  const response = await mutationFetch('/api/share', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionFile }),
  });
  return readJson(response, 'Failed to share session');
}

export function shareUnavailableMessage(capability) {
  if (capability.code === 'GH_MISSING') return 'GitHub CLI is not installed';
  if (capability.code === 'GH_UNAUTHENTICATED') return 'GitHub CLI is not signed in';
  return capability.error || capability.message || capability.code || 'Sharing is unavailable';
}

function element(documentRef, tagName, className, text) {
  const node = documentRef.createElement(tagName);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function metadataList(documentRef, file, inspection) {
  const list = element(documentRef, 'dl', 'session-transfer-metadata');
  const rows = [
    ['File', file.name],
    ['Session', inspection.id],
    ['Entries', inspection.entryCount],
    [inspection.requiresProject ? 'Original directory' : 'Working directory', inspection.cwd || 'Not recorded'],
  ];
  for (const [label, value] of rows) {
    const term = element(documentRef, 'dt', '', label);
    const detail = element(documentRef, 'dd', '', String(value));
    list.append(term, detail);
  }
  return list;
}

export function createSessionTransfer({
  openPanel,
  mutationFetch,
  onImport,
  onDownloadHtml,
  fetchImpl = fetch,
  clipboard = navigator.clipboard,
  documentRef = document,
  openUrl = (url) => window.open(url, '_blank', 'noopener,noreferrer'),
}) {
  function openImport() {
    const panel = openPanel('Import session', 'import');
    const form = element(documentRef, 'form', 'session-transfer-view');
    const fileLabel = element(documentRef, 'label', 'session-transfer-field', 'JSONL file');
    const input = element(documentRef, 'input', 'session-transfer-file');
    input.type = 'file';
    input.accept = '.jsonl';
    input.required = true;
    input.setAttribute('aria-label', 'JSONL session file');
    fileLabel.appendChild(input);
    const details = element(documentRef, 'div', 'session-transfer-details');
    const actions = element(documentRef, 'div', 'dialog-actions');
    const cancel = element(documentRef, 'button', '', 'Cancel');
    cancel.type = 'button';
    cancel.addEventListener('click', panel.close);
    const submit = element(documentRef, 'button', '', 'Import & open');
    submit.type = 'submit';
    submit.disabled = true;
    actions.append(cancel, submit);
    form.append(fileLabel, details, actions);
    panel.body.replaceChildren(form);

    let selectionId = 0;
    let selectedFile = null;
    let inspection = null;
    let projectSelect = null;

    input.addEventListener('change', async () => {
      const currentSelection = ++selectionId;
      selectedFile = input.files?.[0] || null;
      inspection = null;
      projectSelect = null;
      submit.disabled = true;
      details.replaceChildren();
      if (!selectedFile) {
        panel.setStatus('Choose a JSONL file');
        return;
      }

      const file = selectedFile;
      panel.setStatus('Inspecting session...');
      try {
        const result = await inspectSessionImport(file, mutationFetch);
        if (!panel.isCurrent() || currentSelection !== selectionId) return;
        inspection = result;
        details.appendChild(metadataList(documentRef, file, result));

        if (result.requiresProject) {
          const projects = await requestImportProjects(fetchImpl);
          if (!panel.isCurrent() || currentSelection !== selectionId) return;
          const field = element(documentRef, 'label', 'session-transfer-field', 'Project directory');
          projectSelect = element(documentRef, 'select', 'dialog-select');
          projectSelect.required = true;
          const placeholder = element(documentRef, 'option', '', 'Choose project');
          placeholder.value = '';
          projectSelect.appendChild(placeholder);
          for (const option of importProjectOptions(projects)) {
            const item = element(documentRef, 'option', '', option.label);
            item.value = option.path;
            projectSelect.appendChild(item);
          }
          projectSelect.addEventListener('change', () => {
            submit.disabled = !projectSelect.value;
          });
          field.appendChild(projectSelect);
          details.appendChild(field);
          submit.disabled = true;
          panel.setStatus('Choose the directory for this session');
        } else {
          submit.disabled = false;
          panel.setStatus('');
        }
      } catch (error) {
        if (panel.isCurrent() && currentSelection === selectionId) {
          panel.setStatus(error.message, true);
        }
      }
    });

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!selectedFile || !inspection) return;
      const projectPath = inspection.requiresProject ? projectSelect?.value : undefined;
      if (inspection.requiresProject && !projectPath) {
        panel.setStatus('Choose a project directory', true);
        return;
      }
      submit.disabled = true;
      panel.setStatus('Waiting for trust confirmation...');
      try {
        await onImport({ file: selectedFile, projectPath });
      } catch (error) {
        if (panel.isCurrent()) {
          panel.setStatus(error.message, true);
        }
      }
    });

    input.focus();
  }

  function downloadButton(panel, context, root) {
    const button = element(documentRef, 'button', 'session-transfer-action', 'Download HTML');
    button.type = 'button';
    button.addEventListener('click', async () => {
      button.disabled = true;
      panel.setStatus('Preparing HTML...');
      try {
        await onDownloadHtml(context);
        panel.setStatus('HTML downloaded');
      } catch (error) {
        panel.setStatus(error.message, true);
        if (panel.isCurrent()) button.disabled = false;
      }
    });
    root.replaceChildren(button);
  }

  async function openShare(context) {
    const panel = openPanel('Share session', 'share');
    const view = element(documentRef, 'div', 'session-transfer-view');
    const warning = element(
      documentRef,
      'p',
      'session-transfer-warning',
      'A secret gist contains session content. Anyone with the URL can read it.',
    );
    const actions = element(documentRef, 'div', 'session-transfer-actions');
    view.append(warning, actions);
    panel.body.replaceChildren(view);

    if (!context?.sessionFile) {
      panel.setStatus('Share requires a persisted session', true);
      return;
    }

    panel.setStatus('Checking sharing availability...');
    try {
      const capability = await requestShareCapability(fetchImpl);
      if (!panel.isCurrent()) return;
      if (!capability.available) {
        panel.setStatus(shareUnavailableMessage(capability), true);
        if (capability.fallback === 'html_download') downloadButton(panel, context, actions);
        return;
      }

      panel.setStatus('');
      const create = element(documentRef, 'button', 'session-transfer-action', 'Create secret gist');
      create.type = 'button';
      actions.appendChild(create);
      create.addEventListener('click', async () => {
        create.disabled = true;
        panel.setStatus('Creating secret gist...');
        try {
          const result = await createSessionShare(context.sessionFile, mutationFetch);
          if (!panel.isCurrent()) return;
          const resultRow = element(documentRef, 'div', 'session-transfer-result');
          const link = element(documentRef, 'a', 'session-transfer-url', result.url);
          link.href = result.url;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          const copy = element(documentRef, 'button', '', 'Copy');
          copy.type = 'button';
          copy.addEventListener('click', async () => {
            try {
              await copyText(result.url, { clipboard, documentRef });
              panel.setStatus('Link copied');
            } catch (error) {
              panel.setStatus(error.message, true);
            }
          });
          const open = element(documentRef, 'button', '', 'Open');
          open.type = 'button';
          open.addEventListener('click', () => openUrl(result.url));
          resultRow.append(link, copy, open);
          actions.replaceChildren(resultRow);
          panel.setStatus('Secret gist created');
        } catch (error) {
          if (!panel.isCurrent()) return;
          panel.setStatus(error.message, true);
          if (error.fallback === 'html_download') {
            downloadButton(panel, context, actions);
          } else {
            create.disabled = false;
          }
        }
      });
    } catch (error) {
      if (!panel.isCurrent()) return;
      panel.setStatus(error.message, true);
      if (error.fallback === 'html_download') downloadButton(panel, context, actions);
    }
  }

  return { openImport, openShare };
}
