function responseError(data, fallback) {
  return new Error(data?.error || data?.message || fallback);
}

async function readJson(response, fallback) {
  const data = await response.json();
  if (!response.ok) throw responseError(data, fallback);
  return data;
}

export async function requestSessionTree(sessionFile, fetchImpl = fetch) {
  if (!sessionFile) throw new Error('This session has not been persisted yet');
  const response = await fetchImpl(`/api/session-tree?sessionFile=${encodeURIComponent(sessionFile)}`);
  return readJson(response, 'Failed to load session tree');
}

export async function requestSessionOperation(operation, { sessionFile, entryId }, mutationFetch = fetch) {
  if (!['fork', 'branch', 'duplicate'].includes(operation)) throw new Error('Unknown session operation');
  if (!sessionFile) throw new Error('This session has not been persisted yet');
  const body = operation === 'duplicate' ? { sessionFile } : { sessionFile, entryId };
  const response = await mutationFetch(`/api/session-ops/${operation}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return readJson(response, `Failed to ${operation} session`);
}

export async function setSessionEntryLabel({ active, sessionFile, entryId, label, request, mutationFetch }) {
  if (active) {
    const response = await request({ type: 'set_entry_label', sessionFile, entryId, label });
    return response.data;
  }
  const response = await mutationFetch('/api/session-ops/label', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionFile, entryId, label }),
  });
  return readJson(response, 'Failed to update label');
}

export function flattenSessionTree(roots) {
  const result = [];
  const stack = [];
  for (let index = (roots?.length || 0) - 1; index >= 0; index -= 1) {
    const entry = roots[index]?.entry;
    stack.push({
      node: roots[index],
      depth: 1,
      orphan: typeof entry?.parentId === 'string' && entry.parentId !== entry.id,
      rootIndex: index,
    });
  }

  while (stack.length > 0) {
    const frame = stack.pop();
    const { node } = frame;
    const entry = node?.entry;
    const visible = typeof entry?.id === 'string';
    if (visible) result.push({ ...frame, entry, label: node.label ?? null });

    const children = Array.isArray(node?.children) ? node.children : [];
    const nextDepth = visible ? frame.depth + 1 : frame.depth;
    const nextOrphan = visible ? false : frame.orphan;
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push({
        node: children[index],
        depth: nextDepth,
        orphan: nextOrphan,
        rootIndex: frame.rootIndex,
      });
    }
  }
  return result;
}

export function sessionTreePath(roots, targetId) {
  const entries = new Map();
  const parents = new Map();
  const stack = [];
  for (let index = (roots?.length || 0) - 1; index >= 0; index -= 1) {
    stack.push({ node: roots[index], parentId: null });
  }
  while (stack.length > 0) {
    const { node, parentId } = stack.pop();
    const entry = node?.entry;
    if (typeof entry?.id === 'string') {
      entries.set(entry.id, entry);
      parents.set(entry.id, parentId);
    }
    const children = Array.isArray(node?.children) ? node.children : [];
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push({ node: children[index], parentId: entry?.id ?? parentId });
    }
  }
  if (!entries.has(targetId)) return [];
  const path = [];
  for (let id = targetId; id !== null && entries.has(id); id = parents.get(id) ?? null) {
    path.push(entries.get(id));
  }
  return path.reverse();
}

export function sessionEntryPath(entries, targetId) {
  const byId = new Map((entries || [])
    .filter((entry) => typeof entry?.id === 'string')
    .map((entry) => [entry.id, entry]));
  if (!byId.has(targetId)) return [];
  const path = [];
  const visited = new Set();
  for (let id = targetId; id !== null && byId.has(id);) {
    if (visited.has(id)) throw new Error('Session tree contains a cycle');
    visited.add(id);
    const entry = byId.get(id);
    path.push(entry);
    id = entry.parentId === id ? null : entry.parentId ?? null;
  }
  return path.reverse();
}

export function treeEntryTitle(entry) {
  if (entry.type === 'message') {
    const content = entry.message?.content;
    const text = typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.filter((block) => block?.type === 'text').map((block) => block.text).join('')
        : '';
    return `${entry.message?.role || 'message'}: ${text.replace(/\s+/g, ' ').trim() || '(empty)'}`;
  }
  if (entry.type === 'compaction') return `compaction: ${entry.summary || '(no summary)'}`;
  if (entry.type === 'branch_summary') return `branch summary: ${entry.summary || '(no summary)'}`;
  if (entry.type === 'model_change') return `model: ${entry.provider}/${entry.modelId}`;
  if (entry.type === 'thinking_level_change') return `thinking: ${entry.thinkingLevel}`;
  if (entry.type === 'label') return `label: ${entry.label || 'removed'}`;
  if (entry.type === 'session_info') return 'session info';
  if (entry.type === 'custom') return `custom: ${entry.customType || 'data'}`;
  if (entry.type === 'custom_message') return `${entry.customType || 'custom message'}${entry.display === false ? ' (hidden)' : ''}`;
  return entry.type || 'entry';
}

function element(documentRef, tagName, className, text) {
  const node = documentRef.createElement(tagName);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function copyText(text, { clipboard, documentRef }) {
  if (clipboard?.writeText) return clipboard.writeText(text);
  const input = documentRef.createElement('textarea');
  input.value = text;
  input.style.cssText = 'position:fixed;left:-9999px';
  documentRef.body.appendChild(input);
  input.select();
  documentRef.execCommand('copy');
  input.remove();
  return Promise.resolve();
}

export function createSessionTree({
  openPanel,
  getContext,
  onPreview,
  onOperation,
  request,
  mutationFetch,
  fetchImpl = fetch,
  clipboard = navigator.clipboard,
  documentRef = document,
}) {
  async function open(selectedEntryId = null, focusLabel = false) {
    const context = getContext();
    if (!context) throw new Error('Select a session first');
    const panel = openPanel('Session tree', 'tree');
    panel.setStatus('Loading session tree...');
    let data;
    try {
      data = await requestSessionTree(context.sessionFile, fetchImpl);
    } catch (error) {
      panel.setStatus(error.message, true);
      return;
    }
    if (!panel.isCurrent()) return;
    panel.setStatus('');

    const flat = flattenSessionTree(data.roots);
    if (flat.length === 0) {
      panel.setStatus('This session tree is empty', true);
      return;
    }
    const byId = new Map(flat.map((item) => [item.entry.id, item]));
    const activePath = new Set(data.activePath || []);
    let selectedId = byId.has(selectedEntryId)
      ? selectedEntryId
      : byId.has(data.leafId) ? data.leafId : flat.at(-1).entry.id;
    let busy = false;
    const root = element(documentRef, 'div', 'session-tree-view');
    panel.body.replaceChildren(root);

    const currentLabel = (item) => item.label;

    function actionButton(icon, label, action) {
      const button = element(documentRef, 'button', 'session-tree-action');
      button.type = 'button';
      button.dataset.treeAction = action;
      button.title = label;
      button.setAttribute('aria-label', label);
      const symbol = element(documentRef, 'span', 'session-tree-action-icon', icon);
      symbol.setAttribute('aria-hidden', 'true');
      button.append(symbol, label);
      return button;
    }

    function render(focus = null) {
      const summary = element(documentRef, 'div', 'session-tree-summary');
      const name = element(documentRef, 'strong', '', data.name || 'Untitled session');
      const counts = element(documentRef, 'span', '', `${flat.length} entries · ${data.activePath?.length || 0} active`);
      summary.append(name, counts);

      const tree = element(documentRef, 'div', 'session-tree-list');
      tree.setAttribute('role', 'tree');
      tree.setAttribute('aria-label', 'Session branches');
      for (const item of flat) {
        const id = item.entry.id;
        const button = element(documentRef, 'button', 'session-tree-node');
        button.type = 'button';
        button.dataset.treeEntryId = id;
        button.setAttribute('role', 'treeitem');
        button.setAttribute('aria-level', String(item.depth));
        button.setAttribute('aria-selected', String(id === selectedId));
        button.tabIndex = id === selectedId ? 0 : -1;
        button.style.setProperty('--tree-depth', String(item.depth - 1));
        if (id === selectedId) button.classList.add('selected');
        if (activePath.has(id)) button.classList.add('active-path');
        if (item.orphan) button.classList.add('orphan');
        if (item.depth === 1 && item.rootIndex > 0) button.classList.add('new-root');
        const marker = element(documentRef, 'span', 'session-tree-marker', activePath.has(id) ? '●' : '○');
        marker.setAttribute('aria-hidden', 'true');
        const title = element(documentRef, 'span', 'session-tree-node-title', treeEntryTitle(item.entry));
        const badges = element(documentRef, 'span', 'session-tree-badges');
        const label = currentLabel(item);
        if (label) badges.appendChild(element(documentRef, 'span', 'session-tree-label', label));
        if (id === data.leafId) badges.appendChild(element(documentRef, 'span', 'session-tree-leaf', 'leaf'));
        if (item.orphan) badges.appendChild(element(documentRef, 'span', 'session-tree-orphan', 'orphan'));
        button.append(marker, title, badges);
        tree.appendChild(button);
      }

      const item = byId.get(selectedId);
      const details = element(documentRef, 'section', 'session-tree-details');
      details.setAttribute('aria-label', 'Selected entry');
      const heading = element(documentRef, 'h3', '', treeEntryTitle(item.entry));
      const entryId = element(documentRef, 'code', 'session-tree-entry-id', item.entry.id);
      const actions = element(documentRef, 'div', 'session-tree-actions');
      actions.append(
        actionButton('◉', 'Preview branch', 'preview'),
        actionButton('↗', 'Open as new task', 'branch'),
      );
      if (item.entry.type === 'message' && item.entry.message?.role === 'user') {
        actions.appendChild(actionButton('✎', 'Edit & fork', 'fork'));
      }
      actions.appendChild(actionButton('⎘', 'Copy entry ID', 'copy'));

      const labelForm = element(documentRef, 'form', 'session-tree-label-form');
      const labelInput = element(documentRef, 'input', 'session-tree-label-input');
      labelInput.name = 'label';
      labelInput.placeholder = 'Entry label';
      labelInput.setAttribute('aria-label', 'Entry label');
      labelInput.value = currentLabel(item) || '';
      const save = actionButton('#', 'Save label', 'save-label');
      save.type = 'submit';
      delete save.dataset.treeAction;
      labelForm.append(labelInput, save);
      if (currentLabel(item)) labelForm.appendChild(actionButton('×', 'Remove label', 'remove-label'));
      details.append(heading, entryId, actions, labelForm);
      root.replaceChildren(summary, tree, details);
      root.querySelectorAll('button, input').forEach((control) => { control.disabled = busy; });

      if (focus === 'tree') {
        Array.from(tree.querySelectorAll('[role="treeitem"]'))
          .find((node) => node.dataset.treeEntryId === selectedId)?.focus();
      } else if (focus === 'label') {
        root.querySelector('.session-tree-label-input')?.focus();
      }
    }

    async function runAction(action) {
      if (busy) return;
      const item = byId.get(selectedId);
      if (action === 'copy') {
        await copyText(item.entry.id, { clipboard, documentRef });
        panel.setStatus('Entry ID copied');
        return;
      }
      if (action === 'preview') {
        const entries = sessionTreePath(data.roots, selectedId);
        if (entries.length === 0) throw new Error('Selected branch no longer exists');
        await onPreview({ data, entries, target: item.entry });
        panel.close();
        return;
      }
      busy = true;
      render();
      panel.setStatus(action === 'fork' ? 'Creating fork...' : 'Opening branch...');
      try {
        await onOperation(action, context, item.entry, data);
        panel.close();
      } finally {
        busy = false;
        if (panel.isCurrent()) render();
      }
    }

    root.addEventListener('click', (event) => {
      const node = event.target.closest?.('[data-tree-entry-id]');
      if (node && root.contains(node)) {
        selectedId = node.dataset.treeEntryId;
        render('tree');
        return;
      }
      const action = event.target.closest?.('[data-tree-action]');
      if (!action || !root.contains(action)) return;
      if (action.dataset.treeAction === 'remove-label') {
        void updateLabel(null).catch((error) => panel.setStatus(error.message, true));
      } else {
        void runAction(action.dataset.treeAction).catch((error) => panel.setStatus(error.message, true));
      }
    });

    root.addEventListener('keydown', (event) => {
      const current = event.target.closest?.('[role="treeitem"]');
      if (!current) return;
      const nodes = Array.from(root.querySelectorAll('[role="treeitem"]'));
      const index = nodes.indexOf(current);
      let next = null;
      if (event.key === 'ArrowDown') next = nodes[index + 1];
      else if (event.key === 'ArrowUp') next = nodes[index - 1];
      else if (event.key === 'Home') next = nodes[0];
      else if (event.key === 'End') next = nodes.at(-1);
      else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        selectedId = current.dataset.treeEntryId;
        render('tree');
        return;
      }
      if (next) {
        event.preventDefault();
        selectedId = next.dataset.treeEntryId;
        render('tree');
      }
    });

    async function updateLabel(label) {
      if (busy) return;
      busy = true;
      render();
      panel.setStatus(label === null ? 'Removing label...' : 'Saving label...');
      try {
        await setSessionEntryLabel({
          active: context.active,
          sessionFile: context.sessionFile,
          entryId: selectedId,
          label,
          request,
          mutationFetch,
        });
        if (panel.isCurrent()) await open(selectedId, true);
      } finally {
        busy = false;
        if (panel.isCurrent()) render('label');
      }
    }

    root.addEventListener('submit', (event) => {
      if (!event.target.matches('.session-tree-label-form')) return;
      event.preventDefault();
      const label = event.target.elements.label.value.trim();
      void updateLabel(label || null).catch((error) => panel.setStatus(error.message, true));
    });

    render(focusLabel ? 'label' : 'tree');
  }

  return { open };
}
