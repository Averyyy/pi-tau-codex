/**
 * Session Sidebar - Lists sessions grouped by project, handles switching
 */

const LEGACY_PREFERENCE_KEYS = [
  'tau-collapsed-projects',
  'tau-favourites',
  'tau-hidden-projects',
  'tau-project-names',
  'tau-project-order',
  'tau-pinned-projects',
  'tau-sidebar-projects-open',
  'tau-sidebar-tasks-open',
  'tau-sidebar-hidden-open',
];

function defaultSidebarPreferences() {
  return {
    revision: 0,
    favourites: [],
    hiddenProjects: [],
    projectNames: {},
    projectOrder: [],
    pinnedProjects: [],
    collapsedProjects: [],
    sections: {
      favouritesOpen: true,
      projectsOpen: true,
      tasksOpen: true,
      hiddenProjectsOpen: false,
    },
  };
}

function readLegacySidebarPreferences() {
  const readJson = (key, fallback) => {
    const value = localStorage.getItem(key);
    return value === null ? fallback : JSON.parse(value);
  };
  return {
    favourites: readJson('tau-favourites', []),
    hiddenProjects: readJson('tau-hidden-projects', []),
    projectNames: readJson('tau-project-names', {}),
    projectOrder: readJson('tau-project-order', []),
    pinnedProjects: readJson('tau-pinned-projects', []),
    collapsedProjects: readJson('tau-collapsed-projects', []),
    sections: {
      projectsOpen: localStorage.getItem('tau-sidebar-projects-open') !== 'false',
      tasksOpen: localStorage.getItem('tau-sidebar-tasks-open') !== 'false',
      hiddenProjectsOpen: localStorage.getItem('tau-sidebar-hidden-open') === 'true',
    },
  };
}

function clearLegacySidebarPreferences() {
  for (const key of LEGACY_PREFERENCE_KEYS) localStorage.removeItem(key);
}

export class SessionSidebar {
  constructor(container, onSessionSelect, mutationFetch) {
    this.container = container;
    this.onSessionSelect = onSessionSelect;
    this.mutationFetch = mutationFetch;
    this.activeSessionFile = null;
    this.projects = [];
    this.tasks = null;
    this.searchQuery = '';
    this.preferenceWrites = Promise.resolve();
    this.applyPreferences(defaultSidebarPreferences());
    this.preferencesReady = null;
    this.contextMenu = null;
    this.projectDrag = null;
    this.hoverCard = document.createElement('div');
    this.hoverCard.className = 'session-hover-card';
    this.hoverCard.setAttribute('role', 'tooltip');
    document.body.appendChild(this.hoverCard);

    // Close context menu on click anywhere
    document.addEventListener('click', () => this.closeContextMenu());
    document.addEventListener('contextmenu', (e) => {
      // Close if right-clicking outside a session item
      if (!e.target.closest('.session-item')) this.closeContextMenu();
    });
    document.addEventListener('pointermove', (e) => this.handleProjectPointerMove(e));
    document.addEventListener('pointerup', (e) => this.finishProjectPointerDrag(e));
    document.addEventListener('pointercancel', (e) => this.cancelProjectPointerDrag(e));
  }

  applyPreferences(preferences) {
    this.preferences = preferences;
    this.favourites = preferences.favourites;
    this.hiddenProjects = preferences.hiddenProjects;
    this.projectNames = preferences.projectNames;
    this.projectOrder = preferences.projectOrder;
    this.pinnedProjects = preferences.pinnedProjects;
    this.collapsedProjects = new Set(preferences.collapsedProjects);
    this.favouritesOpen = preferences.sections.favouritesOpen;
    this.projectsOpen = preferences.sections.projectsOpen;
    this.tasksOpen = preferences.sections.tasksOpen;
    this.hiddenProjectsOpen = preferences.sections.hiddenProjectsOpen;
  }

  async bootstrapPreferences() {
    const res = await this.mutationFetch('/api/sidebar-preferences', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'bootstrap', preferences: readLegacySidebarPreferences() }),
    });
    if (!res.ok) throw new Error((await res.json()).error || 'Failed to load sidebar preferences');
    const data = await res.json();
    this.applyPreferences(data.preferences);
    clearLegacySidebarPreferences();
  }

  ensurePreferencesReady() {
    if (this.preferencesReady) return this.preferencesReady;
    const pending = this.bootstrapPreferences();
    this.preferencesReady = pending;
    void pending.catch(() => {
      if (this.preferencesReady === pending) this.preferencesReady = null;
    });
    return pending;
  }

  queuePreferenceMutation(mutation, render = true) {
    const write = this.preferenceWrites.then(async () => {
      const res = await this.mutationFetch('/api/sidebar-preferences', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(mutation),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save sidebar preferences');
      this.applyPreferences(data.preferences);
      if (render) this.render();
      return data.preferences;
    });
    this.preferenceWrites = write.catch(() => undefined);
    return write;
  }

  commitPreferenceMutation(mutation) {
    void this.queuePreferenceMutation(mutation).catch((error) => {
      console.error('[Sidebar] Failed to save preferences:', error);
    });
  }

  isFavourite(filePath) {
    return this.favourites.includes(filePath);
  }

  toggleFavourite(filePath) {
    this.commitPreferenceMutation({ type: 'toggle_favourite', filePath });
  }

  projectDisplayName(project) {
    if (this.projectNames[project.path]) return this.projectNames[project.path];
    const cleanPath = project.path.replace(/[\\/]+$/, '');
    const pathParts = cleanPath.split(/[\\/]+/).filter(Boolean);
    return pathParts.length > 0 ? pathParts[pathParts.length - 1] : cleanPath;
  }

  isProjectHidden(project) {
    return this.hiddenProjects.includes(project.path);
  }

  async loadSessions(showLoading = true) {
    try {
      if (showLoading) {
        this.container.innerHTML = Array.from({length: 6}, () =>
          '<div class="session-skeleton"><div class="session-skeleton-title"></div><div class="session-skeleton-meta"></div></div>'
        ).join('');
      }
      await this.ensurePreferencesReady();
      const res = await fetch('/api/sessions');
      if (!res.ok) throw new Error('Failed to load sessions');
      const data = await res.json();
      this.projects = data.projects || [];
      this.tasks = data.tasks || null;
      await this.normalizeCollapsedProjectKeys();
      this.render();
    } catch (error) {
      console.error('[Sidebar] Failed to load sessions:', error);
      this.container.innerHTML = '<div class="session-loading">Failed to load sessions</div>';
    }
  }

  async normalizeCollapsedProjectKeys() {
    const mappings = this.projects
      .filter((project) => this.collapsedProjects.has(project.dirName) && !this.collapsedProjects.has(project.path))
      .map((project) => ({ projectPath: project.path, legacyKey: project.dirName }));
    if (mappings.length > 0) {
      await this.queuePreferenceMutation({ type: 'normalize_collapsed_projects', mappings }, false);
    }
  }

  setSearchQuery(query) {
    this.searchQuery = query.toLowerCase().trim();

    // Clear pending full-text search
    if (this._searchTimer) clearTimeout(this._searchTimer);

    if (!this.searchQuery) {
      this._searchResults = null;
      this.applySearch();
      return;
    }

    // Instant: filter titles
    this.applySearch();

    // Debounced: full-text search (300ms)
    if (this.searchQuery.length >= 2) {
      this._searchTimer = setTimeout(() => this.fullTextSearch(this.searchQuery), 300);
    }
  }

  async fullTextSearch(query) {
    // Don't search if query changed since debounce
    if (query !== this.searchQuery) return;

    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
      const data = await res.json();
      if (query !== this.searchQuery) return; // stale

      this._searchResults = data.results || [];
      this.renderSearchResults();
    } catch (err) {
      console.error('[Sidebar] Search failed:', err);
    }
  }

  renderSearchResults() {
    // Remove previous search results section
    const existing = this.container.querySelector('.search-results-group');
    if (existing) existing.remove();

    if (!this._searchResults || this._searchResults.length === 0) return;

    const group = document.createElement('div');
    group.className = 'search-results-group';

    const header = document.createElement('div');
    header.className = 'project-header search-results-header';
    header.innerHTML = `<span>🔍</span> <span>Message matches</span> <span class="project-count">${this._searchResults.length}</span>`;
    group.appendChild(header);

    const sessionsDiv = document.createElement('div');
    sessionsDiv.className = 'project-sessions';

    for (const result of this._searchResults) {
      const item = document.createElement('div');
      item.className = 'session-item search-result-item';
      item.dataset.filePath = result.filePath;

      if (result.filePath === this.activeSessionFile) {
        item.classList.add('active');
      }

      const title = result.sessionName || result.firstMessage || 'Untitled';
      const snippet = result.matches[0]?.snippet || '';
      const matchCount = result.matches.length;
      const time = this.formatTime(result.sessionTimestamp);

      item.innerHTML = `
        <div class="session-title-row">
          <div class="session-title" title="${this.escapeHtml(title)}">${this.escapeHtml(title)}</div>
        </div>
        <div class="search-snippet">${this.highlightMatch(snippet, this.searchQuery)}</div>
        <div class="session-meta">${time}${matchCount > 1 ? ` · ${matchCount} matches` : ''}</div>
      `;

      // Find the matching project/session to pass to onSessionSelect
      item.addEventListener('click', () => {
        for (const project of this.allGroups()) {
          const session = project.sessions.find(s => s.filePath === result.filePath);
          if (session) {
            this.onSessionSelect(session, project);
            return;
          }
        }
        // Session not in loaded list (unlikely) — try switching by path
        this.onSessionSelect({ filePath: result.filePath, name: result.sessionName }, { path: result.project });
      });

      sessionsDiv.appendChild(item);
    }

    group.appendChild(sessionsDiv);
    // Insert at top of container
    this.container.insertBefore(group, this.container.firstChild);
  }

  highlightMatch(text, query) {
    if (!query) return this.escapeHtml(text);
    const escaped = this.escapeHtml(text);
    const re = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    return escaped.replace(re, '<mark>$1</mark>');
  }

  applySearch() {
    if (!this.searchQuery) {
      this.container.querySelectorAll('.session-item').forEach(el => el.classList.remove('hidden'));
      this.container.querySelectorAll('.project-group').forEach(el => el.style.display = '');
      const favSection = this.container.querySelector('.favourites-group');
      if (favSection) favSection.style.display = '';
      // Remove full-text results
      const searchGroup = this.container.querySelector('.search-results-group');
      if (searchGroup) searchGroup.remove();
      return;
    }

    // Search favourites section
    const favSection = this.container.querySelector('.favourites-group');
    if (favSection) {
      let hasVisible = false;
      favSection.querySelectorAll('.session-item').forEach(item => {
        const title = (item.querySelector('.session-title')?.textContent || '').toLowerCase();
        const matches = title.includes(this.searchQuery);
        item.classList.toggle('hidden', !matches);
        if (matches) hasVisible = true;
      });
      favSection.style.display = hasVisible ? '' : 'none';
    }

    this.container.querySelectorAll('.project-group').forEach(group => {
      let hasVisible = false;
      group.querySelectorAll('.session-item').forEach(item => {
        const title = (item.querySelector('.session-title')?.textContent || '').toLowerCase();
        const matches = title.includes(this.searchQuery);
        item.classList.toggle('hidden', !matches);
        if (matches) hasVisible = true;
      });
      group.style.display = hasVisible ? '' : 'none';
    });
    this.container.querySelectorAll('.task-sessions .session-item').forEach(item => {
      const title = (item.querySelector('.session-title')?.textContent || '').toLowerCase();
      item.classList.toggle('hidden', !title.includes(this.searchQuery));
    });
  }

  setActive(filePath) {
    this.activeSessionFile = filePath;
    this.container.querySelectorAll('.session-item').forEach(el => {
      el.classList.toggle('active', el.dataset.filePath === filePath);
    });
  }

  clearActive() {
    this.activeSessionFile = null;
    this.container.querySelectorAll('.session-item').forEach(el => el.classList.remove('active'));
  }

  // ═══════════════════════════════════════
  // Context Menu
  // ═══════════════════════════════════════

  showContextMenu(e, session) {
    e.preventDefault();
    this.hideSessionHoverCard();
    this.closeContextMenu();

    const isFav = this.isFavourite(session.filePath);
    const menu = document.createElement('div');
    menu.className = 'session-context-menu';

    const items = [
      { icon: isFav ? '★' : '☆', label: isFav ? 'Unfavourite' : 'Favourite', action: () => this.toggleFavourite(session.filePath) },
      { icon: '🗑', label: 'Delete', action: () => this.deleteSession(session) },
    ];

    for (const item of items) {
      const row = document.createElement('div');
      row.className = 'context-menu-item';
      row.innerHTML = `<span class="context-menu-icon">${item.icon}</span>${item.label}`;
      row.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this.closeContextMenu();
        item.action();
      });
      menu.appendChild(row);
    }

    this.positionContextMenu(menu, e.clientX, e.clientY);
  }

  showProjectMenu(e, project) {
    e.preventDefault();
    e.stopPropagation();
    this.closeContextMenu();

    const hidden = this.isProjectHidden(project);
    const pinned = this.pinnedProjects.includes(project.path);
    const items = [
      { icon: pinned ? '✓' : '↑', label: pinned ? '取消置顶' : '置顶项目', action: () => this.toggleProjectPinned(project) },
      { icon: hidden ? '☑' : '☐', label: hidden ? '取消隐藏' : '隐藏项目', action: () => this.toggleProjectHidden(project) },
      { icon: '✎', label: '重命名项目', action: () => this.renameProject(project) },
      { icon: '↗', label: '在 Finder / Explorer 中打开', action: () => this.openProjectFolder(project) },
    ];

    const menu = document.createElement('div');
    menu.className = 'session-context-menu';
    for (const item of items) {
      const row = document.createElement('div');
      row.className = 'context-menu-item';
      row.innerHTML = `<span class="context-menu-icon">${item.icon}</span>${item.label}`;
      row.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this.closeContextMenu();
        item.action();
      });
      menu.appendChild(row);
    }

    this.positionContextMenu(menu, e.clientX, e.clientY);
  }

  positionContextMenu(menu, x, y) {
    document.body.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    if (x + rect.width > window.innerWidth) x = window.innerWidth - rect.width - 8;
    if (y + rect.height > window.innerHeight) y = window.innerHeight - rect.height - 8;
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    this.contextMenu = menu;
  }

  closeContextMenu() {
    if (this.contextMenu) {
      this.contextMenu.remove();
      this.contextMenu = null;
    }
  }

  async deleteSession(session) {
    if (!confirm(`Delete "${session.name || session.firstMessage || 'this session'}"?`)) return;
    try {
      const res = await this.mutationFetch('/api/sessions/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath: session.filePath }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to delete session');
      }
      await this.queuePreferenceMutation({ type: 'remove_session', filePath: session.filePath }, false);
      // If this was the active session, clear it
      if (session.filePath === this.activeSessionFile) {
        this.clearActive();
        if (this.onSessionSelect) await this.onSessionSelect(null, null);
      }
      await this.loadSessions(false);
    } catch (e) {
      console.error('[Sidebar] Delete failed:', e);
    }
  }

  toggleProjectHidden(project) {
    this.commitPreferenceMutation({ type: 'toggle_project_hidden', projectPath: project.path });
  }

  toggleProjectPinned(project) {
    this.commitPreferenceMutation({ type: 'toggle_project_pinned', projectPath: project.path });
  }

  allGroups() {
    return this.tasks ? [...this.projects, this.tasks] : this.projects;
  }

  orderedProjects(projects) {
    const savedIndex = new Map(this.projectOrder.map((projectPath, index) => [projectPath, index]));
    const sourceIndex = new Map(this.projects.map((project, index) => [project.path, index]));
    const pinnedIndex = new Map(this.pinnedProjects.map((projectPath, index) => [projectPath, index]));
    return [...projects].sort((a, b) => {
      const aPinned = pinnedIndex.get(a.path);
      const bPinned = pinnedIndex.get(b.path);
      if (aPinned !== undefined || bPinned !== undefined) {
        if (aPinned === undefined) return 1;
        if (bPinned === undefined) return -1;
        return aPinned - bPinned;
      }
      return (savedIndex.get(a.path) ?? sourceIndex.get(a.path) ?? Number.MAX_SAFE_INTEGER) -
        (savedIndex.get(b.path) ?? sourceIndex.get(b.path) ?? Number.MAX_SAFE_INTEGER);
    });
  }

  moveProject(sourcePath, targetPath, insertAfter) {
    if (!sourcePath || sourcePath === targetPath) return;
    const sourcePinned = this.pinnedProjects.includes(sourcePath);
    if (sourcePinned !== this.pinnedProjects.includes(targetPath)) return;

    const mutation = {
      type: 'move_project',
      sourcePath,
      targetPath,
      insertAfter,
      projectPaths: this.orderedProjects(this.projects).map((project) => project.path),
    };
    if (sourcePinned) mutation.pinnedProjectPaths = [...this.pinnedProjects];
    this.commitPreferenceMutation(mutation);
  }

  startProjectPointerDrag(event, project, group) {
    if (event.pointerType !== 'mouse' || event.button !== 0 || event.target.closest('.project-menu-btn')) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    this.projectDrag = {
      sourcePath: project.path,
      sourceGroup: group,
      sourceHeader: event.currentTarget,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      targetGroup: null,
      insertAfter: false,
      dragging: false,
    };
  }

  handleProjectPointerMove(event) {
    const drag = this.projectDrag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (!drag.dragging && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 6) return;

    event.preventDefault();
    drag.dragging = true;
    document.body.classList.add('project-dragging');
    drag.sourceGroup.classList.add('dragging');
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest('.project-group');
    const targetRect = target?.getBoundingClientRect();
    const insertAfter = Boolean(targetRect && event.clientY > targetRect.top + targetRect.height / 2);
    const targetPath = target?.dataset.projectPath;
    const validTarget = target && target !== drag.sourceGroup && targetPath &&
      this.pinnedProjects.includes(drag.sourcePath) === this.pinnedProjects.includes(targetPath)
      ? target
      : null;
    if (drag.targetGroup === validTarget && drag.insertAfter === insertAfter) return;
    drag.targetGroup?.classList.remove('drag-over');
    drag.targetGroup?.classList.remove('drag-over-after');
    drag.targetGroup = validTarget;
    drag.insertAfter = drag.targetGroup ? insertAfter : false;
    drag.targetGroup?.classList.add('drag-over');
    drag.targetGroup?.classList.toggle('drag-over-after', drag.insertAfter);
  }

  finishProjectPointerDrag(event) {
    const drag = this.projectDrag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    this.clearProjectPointerDrag(drag);
    if (!drag.dragging) return;

    event.preventDefault();
    const suppressClick = (clickEvent) => {
      clickEvent.preventDefault();
      clickEvent.stopImmediatePropagation();
      drag.sourceHeader.removeEventListener('click', suppressClick, true);
    };
    drag.sourceHeader.addEventListener('click', suppressClick, true);
    requestAnimationFrame(() => drag.sourceHeader.removeEventListener('click', suppressClick, true));
    const targetPath = drag.targetGroup?.dataset.projectPath;
    if (targetPath) this.moveProject(drag.sourcePath, targetPath, drag.insertAfter);
  }

  cancelProjectPointerDrag(event) {
    const drag = this.projectDrag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    this.clearProjectPointerDrag(drag);
  }

  clearProjectPointerDrag(drag) {
    this.projectDrag = null;
    document.body.classList.remove('project-dragging');
    drag.sourceGroup.classList.remove('dragging');
    drag.targetGroup?.classList.remove('drag-over');
    drag.targetGroup?.classList.remove('drag-over-after');
  }

  renameProject(project) {
    const name = prompt('重命名项目', this.projectDisplayName(project));
    if (name === null) return;
    const trimmed = name.trim();
    this.commitPreferenceMutation({ type: 'set_project_name', projectPath: project.path, name: trimmed || null });
  }

  async openProjectFolder(project) {
    const res = await this.mutationFetch('/api/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath: project.path }),
    });
    if (!res.ok) alert('Failed to open project folder');
  }

  // ═══════════════════════════════════════
  // Render
  // ═══════════════════════════════════════

  buildSessionItem(session, project, isTask = false) {
    const item = document.createElement('div');
    item.className = 'session-item';
    item.dataset.filePath = session.filePath;

    if (session.filePath === this.activeSessionFile) {
      item.classList.add('active');
    }

    const title = session.name || session.firstMessage || 'Empty session';
    const time = this.formatTime(session.timestamp);
    const tmuxTag = session.tmux ? '<span class="session-tag tmux-tag">tmux</span>' : '';
    const favIcon = this.isFavourite(session.filePath) ? '<span class="session-fav-icon">★</span>' : '';

    item.innerHTML = `
      <div class="session-title-row">
        ${favIcon}
        <div class="session-title" title="${this.escapeHtml(title)}">${this.escapeHtml(title)}</div>
        ${tmuxTag}
      </div>
      <div class="session-meta">${time}</div>
    `;

    item.addEventListener('click', () => {
      this.hideSessionHoverCard();
      this.onSessionSelect(session, project);
    });
    item.addEventListener('contextmenu', (e) => this.showContextMenu(e, session));
    item.addEventListener('pointerenter', () => this.showSessionHoverCard(item, title, time, project, isTask));
    item.addEventListener('pointerleave', () => this.hideSessionHoverCard());

    return item;
  }

  showSessionHoverCard(item, title, time, project, isTask) {
    if (this.contextMenu) return;
    this.hoverCard.innerHTML = `
      <div class="session-hover-title">${this.escapeHtml(title)}</div>
      <div class="session-hover-meta">${this.escapeHtml(time)}</div>
      <div class="session-hover-context">${isTask ? 'Task' : this.escapeHtml(this.projectDisplayName(project))}</div>
      ${!isTask && project.branch ? `<div class="session-hover-context branch">${this.escapeHtml(project.branch)}</div>` : ''}
    `;
    const rect = item.getBoundingClientRect();
    this.hoverCard.style.left = `${rect.right + 10}px`;
    this.hoverCard.style.top = '12px';
    this.hoverCard.classList.add('visible');
    this.hoverCard.style.top = `${Math.max(12, Math.min(rect.top, window.innerHeight - this.hoverCard.offsetHeight - 12))}px`;
  }

  hideSessionHoverCard() {
    this.hoverCard.classList.remove('visible');
  }

  render() {
    this.hideSessionHoverCard();
    if (this.projects.length === 0 && !this.tasks?.sessions?.length) {
      this.container.innerHTML = '<div class="session-loading">No sessions found</div>';
      return;
    }

    this.container.innerHTML = '';

    const visibleProjects = this.orderedProjects(this.projects.filter(project => !this.isProjectHidden(project)));
    const hiddenProjects = this.projects.filter(project => this.isProjectHidden(project));

    // Favourites are shortcuts, so they remain reachable even when their project is hidden.
    const favSessions = [];
    for (const project of this.allGroups()) {
      for (const session of project.sessions) {
        if (this.isFavourite(session.filePath)) {
          favSessions.push({ session, project, isTask: project === this.tasks });
        }
      }
    }

    if (favSessions.length > 0) {
      const favGroup = document.createElement('div');
      favGroup.className = 'favourites-group';

      const header = document.createElement('div');
      header.className = `project-header favourites-header${this.favouritesOpen ? '' : ' collapsed'}`;
      header.setAttribute('role', 'button');
      header.tabIndex = 0;
      header.innerHTML = `<span class="chevron">▼</span><span class="fav-star">★</span> <span>Favourites</span> <span class="project-count">${favSessions.length}</span>`;
      const toggleFavourites = () => {
        this.commitPreferenceMutation({ type: 'toggle_section', section: 'favourites' });
      };
      header.addEventListener('click', toggleFavourites);
      header.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          toggleFavourites();
        }
      });
      favGroup.appendChild(header);

      const sessionsDiv = document.createElement('div');
      sessionsDiv.className = `project-sessions${this.favouritesOpen ? '' : ' collapsed'}`;
      for (const { session, project, isTask } of favSessions) {
        sessionsDiv.appendChild(this.buildSessionItem(session, project, isTask));
      }
      favGroup.appendChild(sessionsDiv);
      this.container.appendChild(favGroup);
    }

    this.appendCollapsibleSection('Projects', visibleProjects.length, this.projectsOpen, () => {
      this.commitPreferenceMutation({ type: 'toggle_section', section: 'projects' });
    });
    if (this.projectsOpen) this.appendProjectSection('', visibleProjects, false);

    const taskCount = this.tasks?.sessions?.length || 0;
    this.appendCollapsibleSection('Tasks', taskCount, this.tasksOpen, () => {
      this.commitPreferenceMutation({ type: 'toggle_section', section: 'tasks' });
    });
    if (this.tasksOpen && this.tasks) {
      const sessionsDiv = document.createElement('div');
      sessionsDiv.className = 'task-sessions';
      for (const session of this.tasks.sessions) sessionsDiv.appendChild(this.buildSessionItem(session, this.tasks, true));
      this.container.appendChild(sessionsDiv);
    }

    if (hiddenProjects.length > 0) {
      const header = document.createElement('button');
      header.type = 'button';
      header.className = `sidebar-section-header${this.hiddenProjectsOpen ? '' : ' collapsed'}`;
      header.innerHTML = `
        <span>Hidden Projects</span>
        <span class="project-count">${hiddenProjects.length}</span>
      `;
      header.addEventListener('click', () => {
        this.commitPreferenceMutation({ type: 'toggle_section', section: 'hiddenProjects' });
      });
      this.container.appendChild(header);
      if (this.hiddenProjectsOpen) {
        this.appendProjectSection('', hiddenProjects, true);
      }
    }

    if (this.searchQuery) this.applySearch();
  }

  appendCollapsibleSection(title, count, open, onClick) {
    const header = document.createElement('button');
    header.type = 'button';
    header.className = `sidebar-section-header${open ? '' : ' collapsed'}`;
    header.innerHTML = `<span>${this.escapeHtml(title)}</span><span class="project-count">${count}</span>`;
    header.addEventListener('click', onClick);
    this.container.appendChild(header);
  }

  appendProjectSection(title, projects, showHeader) {
    if (showHeader && title) {
      const sectionHeader = document.createElement('div');
      sectionHeader.className = 'sidebar-section-header static';
      sectionHeader.innerHTML = `
        <span>${this.escapeHtml(title)}</span>
        <span class="project-count">${projects.length}</span>
      `;
      this.container.appendChild(sectionHeader);
    }

    for (const project of projects) {
      const group = document.createElement('div');
      group.className = 'project-group';
      group.dataset.projectPath = project.path;
      const isCollapsed = this.collapsedProjects.has(project.path);

      const header = document.createElement('div');
      header.className = `project-header${isCollapsed ? ' collapsed' : ''}`;

      const shortPath = this.projectDisplayName(project);

      header.innerHTML = `
        <span class="chevron">▼</span>
        ${this.pinnedProjects.includes(project.path) ? '<span class="project-pin" aria-label="Pinned">●</span>' : ''}
        <span class="project-title" title="${this.escapeHtml(project.path)}">${this.escapeHtml(shortPath)}</span>
        <span class="project-count">${project.sessions.length}</span>
        <button type="button" class="project-menu-btn" aria-label="Project actions">•••</button>
      `;

      header.addEventListener('click', () => {
        this.commitPreferenceMutation({ type: 'toggle_project_collapsed', projectPath: project.path });
      });

      header.querySelector('.project-menu-btn')?.addEventListener('click', (e) => this.showProjectMenu(e, project));
      header.addEventListener('contextmenu', (e) => this.showProjectMenu(e, project));
      header.addEventListener('pointerdown', (event) => this.startProjectPointerDrag(event, project, group));
      group.appendChild(header);

      const sessionsDiv = document.createElement('div');
      sessionsDiv.className = `project-sessions${isCollapsed ? ' collapsed' : ''}`;

      for (const session of project.sessions) {
        sessionsDiv.appendChild(this.buildSessionItem(session, project));
      }

      group.appendChild(sessionsDiv);
      this.container.appendChild(group);
    }
  }

  formatTime(isoTimestamp) {
    try {
      const date = new Date(isoTimestamp);
      const now = new Date();
      const diffMs = now.getTime() - date.getTime();
      const diffMins = Math.floor(diffMs / 60000);
      const diffHours = Math.floor(diffMs / 3600000);
      const days = Math.floor(diffMs / 86400000);

      if (diffMins < 1) return 'Just now';
      if (diffMins < 60) return `${diffMins}m ago`;
      if (diffHours < 24) return `${diffHours}h ago`;
      if (days === 1) return 'Yesterday';
      if (days < 7) return date.toLocaleDateString([], { weekday: 'long' });
      return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
    } catch {
      return '';
    }
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}
