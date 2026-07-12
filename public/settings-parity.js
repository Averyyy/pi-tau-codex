function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

function setPanelStatus(element, message, error = false) {
  element.textContent = message;
  element.hidden = !message;
  element.classList.toggle('error', error);
}

export function providerActionAccessibleName(label, provider) {
  return `${label} ${provider.name} (${provider.id})`;
}

export function modelRefsForSave(selectedModels, preservedPatternCount) {
  if (selectedModels.size === 0 && preservedPatternCount === 0) {
    throw new Error('Select at least one model when no preserved Pi model patterns remain');
  }
  return [...selectedModels];
}

export function createSettingsParity({ request, onModelsSaved }) {
  const providersStatus = document.getElementById('settings-providers-status');
  const providersList = document.getElementById('settings-providers-list');
  const modelSearch = document.getElementById('settings-model-search');
  const modelSelectAll = document.getElementById('settings-model-select-all');
  const modelsStatus = document.getElementById('settings-models-status');
  const modelProjectWarning = document.getElementById('settings-model-project-warning');
  const modelsList = document.getElementById('settings-models-list');
  const modelPatterns = document.getElementById('settings-model-patterns');
  const modelPatternList = document.getElementById('settings-model-pattern-list');
  const piVersion = document.getElementById('settings-pi-version');
  const tauVersion = document.getElementById('settings-tau-version');
  const aboutStatus = document.getElementById('settings-about-status');
  const changelog = document.getElementById('settings-changelog');

  let models = [];
  let selectedModels = new Set();
  let modelsDirty = false;
  let modelsReadOnly = false;
  let preservedPatternCount = 0;

  function providerAction(label, provider, args, disabled) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'settings-secondary settings-account-action';
    button.textContent = label;
    button.setAttribute('aria-label', providerActionAccessibleName(label, provider));
    button.disabled = disabled;
    button.addEventListener('click', async () => {
      button.disabled = true;
      setPanelStatus(providersStatus, `Running ${label.toLowerCase()} for ${provider.name}...`);
      try {
        await request({ type: 'run_command', name: args.command, args: args.value });
        await loadProviders();
      } catch (error) {
        setPanelStatus(providersStatus, messageOf(error), true);
      } finally {
        button.disabled = false;
      }
    });
    return button;
  }

  function renderProviders(data) {
    providersList.replaceChildren();
    const hasError = data.errors?.length > 0;
    setPanelStatus(
      providersStatus,
      hasError ? data.errors.join('\n') : `${data.providers.length} providers`,
      hasError,
    );

    for (const provider of data.providers) {
      const row = document.createElement('div');
      row.className = 'settings-data-row settings-provider-row';

      const identity = document.createElement('div');
      identity.className = 'settings-data-main';
      const name = document.createElement('strong');
      name.textContent = provider.name;
      const id = document.createElement('span');
      id.textContent = provider.id;
      identity.append(name, id);

      const controls = document.createElement('div');
      controls.className = 'settings-provider-controls';
      const status = document.createElement('span');
      status.className = `settings-provider-status ${provider.status}`;
      status.textContent = provider.status === 'signed_in'
        ? `Signed in${provider.label || provider.source ? ` · ${provider.label || provider.source}` : ''}`
        : provider.status === 'error' ? 'Error' : 'Not configured';
      controls.appendChild(status);

      const disabled = provider.status === 'error';
      if (provider.status !== 'signed_in' && provider.supportsOAuth) {
        controls.appendChild(providerAction(
          'Sign in with OAuth',
          provider,
          { command: 'tau-login', value: `${provider.id} oauth` },
          disabled,
        ));
      }
      if (provider.status !== 'signed_in' && provider.supportsApiKey) {
        controls.appendChild(providerAction(
          'Sign in with API key',
          provider,
          { command: 'tau-login', value: `${provider.id} api-key` },
          disabled,
        ));
      }
      if (provider.canSignOut) {
        controls.appendChild(providerAction(
          'Sign out',
          provider,
          { command: 'tau-logout', value: provider.id },
          disabled,
        ));
      }
      row.append(identity, controls);
      providersList.appendChild(row);
    }

    if (data.providers.length === 0) {
      setPanelStatus(providersStatus, hasError ? data.errors.join('\n') : 'No providers found', hasError);
    }
  }

  async function loadProviders() {
    setPanelStatus(providersStatus, 'Loading providers...');
    const response = await request({ type: 'get_provider_accounts' });
    renderProviders(response.data);
  }

  function updateModelStatus() {
    const count = selectedModels.size;
    setPanelStatus(
      modelsStatus,
      `${count} of ${models.length} exact selections${modelsDirty ? ' · Unsaved' : ''}`,
    );
  }

  function renderModels() {
    modelsList.replaceChildren();
    const query = modelSearch.value.trim().toLowerCase();
    const visible = models.filter((model) =>
      `${model.name} ${model.ref} ${model.providerName}`.toLowerCase().includes(query));

    for (const model of visible) {
      const row = document.createElement('label');
      row.className = 'settings-data-row settings-model-row';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.value = model.ref;
      checkbox.checked = selectedModels.has(model.ref);
      checkbox.disabled = modelsReadOnly;
      checkbox.setAttribute('aria-label', model.ref);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) selectedModels.add(model.ref);
        else selectedModels.delete(model.ref);
        modelsDirty = true;
        updateModelStatus();
      });

      const identity = document.createElement('span');
      identity.className = 'settings-data-main';
      const name = document.createElement('strong');
      name.textContent = model.name || model.id;
      const ref = document.createElement('span');
      ref.textContent = model.ref;
      identity.append(name, ref);
      row.append(checkbox, identity);
      modelsList.appendChild(row);
    }

    if (visible.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'settings-list-empty';
      empty.textContent = 'No matching models';
      modelsList.appendChild(empty);
    }
  }

  function applyModelScope(data) {
    models = data.models || [];
    selectedModels = new Set(models.filter((model) => model.selected).map((model) => model.ref));
    modelsDirty = false;
    modelsReadOnly = data.projectOverride === true;
    preservedPatternCount = data.preservedPatterns?.length || 0;
    modelSelectAll.disabled = modelsReadOnly;
    modelProjectWarning.hidden = !modelsReadOnly;
    modelProjectWarning.textContent = modelsReadOnly
      ? `Project .pi/settings.json overrides global enabledModels${data.projectPatterns?.length ? `: ${data.projectPatterns.join(', ')}` : ''}. Remove the project override before editing global selections.`
      : '';
    modelPatterns.hidden = !data.preservedPatterns?.length;
    modelPatternList.textContent = (data.preservedPatterns || []).join('\n');
    const errors = data.errors || [];
    if (errors.length > 0) setPanelStatus(modelsStatus, errors.join('\n'), true);
    else updateModelStatus();
    renderModels();
  }

  async function loadModels() {
    setPanelStatus(modelsStatus, 'Loading models...');
    const response = await request({ type: 'get_enabled_models' });
    applyModelScope(response.data);
  }

  async function saveModels() {
    if (!modelsDirty) return;
    setPanelStatus(modelsStatus, 'Saving model scope...');
    try {
      const response = await request({
        type: 'set_enabled_models',
        modelRefs: modelRefsForSave(selectedModels, preservedPatternCount),
      });
      applyModelScope(response.data);
      await onModelsSaved();
      setPanelStatus(modelsStatus, `${selectedModels.size} of ${models.length} exact selections · Saved`);
    } catch (error) {
      setPanelStatus(modelsStatus, messageOf(error), true);
      throw error;
    }
  }

  async function loadAbout() {
    setPanelStatus(aboutStatus, 'Loading changelog...');
    const response = await request({ type: 'get_about' });
    const data = response.data;
    piVersion.textContent = data.piVersion;
    tauVersion.textContent = data.tauVersion;
    changelog.replaceChildren();

    for (const entry of data.changelog) {
      const section = document.createElement('section');
      section.className = 'settings-changelog-entry';
      const heading = document.createElement('h4');
      heading.textContent = `${entry.version}${entry.date ? ` · ${entry.date}` : ''}`;
      const body = document.createElement('pre');
      body.textContent = entry.body;
      section.append(heading, body);
      changelog.appendChild(section);
    }
    setPanelStatus(aboutStatus, '');
  }

  async function loadSection(loader, status) {
    try {
      await loader();
    } catch (error) {
      setPanelStatus(status, messageOf(error), true);
    }
  }

  modelSearch.addEventListener('input', renderModels);
  modelSelectAll.addEventListener('click', () => {
    selectedModels = new Set(models.map((model) => model.ref));
    modelsDirty = true;
    renderModels();
    updateModelStatus();
  });

  return {
    load: () => Promise.all([
      loadSection(loadProviders, providersStatus),
      loadSection(loadModels, modelsStatus),
      loadSection(loadAbout, aboutStatus),
    ]),
    save: saveModels,
  };
}
