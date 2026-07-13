const RESOURCE_KINDS = ['extensions', 'skills', 'prompts', 'themes'];

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

function setStatus(element, message, error = false) {
  element.textContent = message;
  element.hidden = !message;
  element.classList.toggle('error', error);
}

export function resourceCounts(resources, source = null, scope = null) {
  return Object.fromEntries(RESOURCE_KINDS.map((kind) => [
    kind,
    (resources?.[kind] || []).filter((resource) => (
      (!source || resource.source === source) && (!scope || resource.scope === scope)
    )).length,
  ]));
}

export function formatResourceCounts(counts) {
  return RESOURCE_KINDS
    .map((kind) => `${counts[kind] || 0} ${kind}`)
    .join(' · ');
}

export function packageActionWarning(action, source) {
  return `${action[0].toUpperCase()}${action.slice(1)} ${source}? Package operations can execute code on this machine.`;
}

export function packageProgressText(progress) {
  if (typeof progress?.message === 'string' && progress.message) return progress.message;
  if (!progress?.action || !progress?.source) return '';
  return `${progress.action[0].toUpperCase()}${progress.action.slice(1)} ${progress.source}`;
}

function actionInProgress(action, source) {
  const verb = { install: 'Installing', update: 'Updating', remove: 'Removing' }[action];
  return `${verb} ${source}...`;
}

export function createPackageSettings({ request, confirmAction = (message) => window.confirm(message) }) {
  const mcpStatus = document.getElementById('settings-mcp-status');
  const mcpEmpty = document.getElementById('settings-mcp-empty');
  const packageForm = document.getElementById('settings-package-form');
  const packageSource = document.getElementById('settings-package-source');
  const packageScope = document.getElementById('settings-package-scope');
  const packageInstall = document.getElementById('settings-package-install');
  const packagesStatus = document.getElementById('settings-packages-status');
  const packagesList = document.getElementById('settings-packages-list');
  const resourceSummary = document.getElementById('settings-resource-summary');

  let busy = false;

  function setBusy(next) {
    busy = next;
    packageSource.disabled = next;
    packageScope.disabled = next;
    packageInstall.disabled = next;
    packagesList.querySelectorAll('button').forEach((button) => { button.disabled = next; });
  }

  function renderResourceSummary(resources) {
    resourceSummary.replaceChildren();
    const counts = resourceCounts(resources);
    for (const kind of RESOURCE_KINDS) {
      const item = document.createElement('span');
      const value = document.createElement('strong');
      value.textContent = counts[kind];
      item.append(value, ` ${kind}`);
      resourceSummary.appendChild(item);
    }
  }

  function actionButton(label, action, pkg, status) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'settings-secondary settings-account-action';
    button.textContent = label;
    button.disabled = busy;
    button.setAttribute('aria-label', `${label} ${pkg.source} (${pkg.scope})`);
    button.addEventListener('click', () => runAction(action, pkg.source, pkg.scope, status));
    return button;
  }

  function renderPackages(data) {
    packagesList.replaceChildren();
    const errors = data.errors || [];
    setStatus(
      packagesStatus,
      errors.length > 0 ? errors.join('\n') : `${data.packages.length} configured packages`,
      errors.length > 0,
    );

    for (const pkg of data.packages) {
      const row = document.createElement('div');
      row.className = 'settings-data-row settings-package-row';

      const identity = document.createElement('div');
      identity.className = 'settings-data-main';
      const source = document.createElement('strong');
      source.textContent = pkg.source;
      const meta = document.createElement('span');
      const state = pkg.missing ? 'Missing' : 'Installed';
      const filtered = pkg.filtered ? ' · Filtered' : '';
      meta.textContent = `${pkg.scope} · ${state}${filtered} · ${formatResourceCounts(resourceCounts(data.resources, pkg.source, pkg.scope))}`;
      identity.append(source, meta);

      const controls = document.createElement('div');
      controls.className = 'settings-provider-controls';
      const actionStatus = document.createElement('span');
      actionStatus.className = 'settings-provider-status';
      actionStatus.setAttribute('role', 'status');
      controls.appendChild(actionStatus);
      controls.appendChild(actionButton(pkg.missing ? 'Install' : 'Update', pkg.missing ? 'install' : 'update', pkg, actionStatus));
      controls.appendChild(actionButton('Remove', 'remove', pkg, actionStatus));
      row.append(identity, controls);
      packagesList.appendChild(row);
    }

    if (data.packages.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'settings-list-empty';
      empty.textContent = 'No packages configured';
      packagesList.appendChild(empty);
    }
    renderResourceSummary(data.resources);
  }

  async function loadPackages() {
    setStatus(packagesStatus, 'Loading packages...');
    const response = await request({ type: 'list_pi_packages' });
    renderPackages(response.data);
  }

  async function loadMcp() {
    setStatus(mcpStatus, 'Checking MCP capability...');
    const response = await request({ type: 'get_mcp_capability' });
    const capability = response.data;
    setStatus(mcpStatus, capability.available ? 'Available' : 'Unavailable');
    mcpEmpty.textContent = capability.reason || '';
    mcpEmpty.hidden = capability.available;
  }

  async function runAction(action, source, scope, rowStatus = packagesStatus) {
    if (busy || !confirmAction(packageActionWarning(action, source))) return;
    setBusy(true);
    setStatus(rowStatus, actionInProgress(action, source));
    try {
      const response = await request({ type: `${action}_pi_package`, source, scope });
      await loadPackages();
      if (response.data?.reloadRequired) {
        setStatus(packagesStatus, `${source} changed. Restart Pi to load the new package state.`);
      }
      return true;
    } catch (error) {
      setStatus(rowStatus, messageOf(error), true);
      return false;
    } finally {
      setBusy(false);
    }
  }

  packageForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const source = packageSource.value.trim();
    if (source && await runAction('install', source, packageScope.value)) packageSource.value = '';
  });

  return {
    async load() {
      await Promise.all([
        loadPackages().catch((error) => setStatus(packagesStatus, messageOf(error), true)),
        loadMcp().catch((error) => {
          setStatus(mcpStatus, 'Unavailable');
          mcpEmpty.hidden = false;
          mcpEmpty.textContent = messageOf(error);
        }),
      ]);
    },
    handleEvent(event) {
      if (event?.type !== 'pi_package_progress') return;
      const message = packageProgressText(event.progress);
      if (message) setStatus(packagesStatus, message, event.progress?.type === 'error');
    },
  };
}
