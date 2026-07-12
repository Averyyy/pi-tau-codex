import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { configureDialogInput, mountExtensionNotification } from '../public/dialogs.js';

test('only explicit secret inputs use password-safe browser attributes', () => {
  const normalAttributes = {};
  const normal = {
    setAttribute: (name, value) => { normalAttributes[name] = value; },
  };
  configureDialogInput(normal, false, 'OAuth prompt');
  assert.equal(normal.type, 'text');
  assert.deepEqual(normalAttributes, { 'aria-label': 'OAuth prompt' });

  const attributes = {};
  const secret = {
    setAttribute: (name, value) => { attributes[name] = value; },
  };
  configureDialogInput(secret, true, 'Provider API key');
  assert.equal(secret.type, 'password');
  assert.equal(secret.spellcheck, false);
  assert.equal(secret.autocapitalize, 'none');
  assert.equal(secret.autocomplete, 'off');
  assert.deepEqual(attributes, {
    'aria-label': 'Provider API key',
    autocorrect: 'off',
  });
});

test('extension dialogs and notifications stay above Settings', () => {
  class Element {
    constructor(tagName) {
      this.tagName = tagName;
      this.children = [];
      this.attributes = {};
      this.parent = null;
    }
    append(...children) {
      for (const child of children) this.appendChild(child);
    }
    appendChild(child) {
      child.parent = this;
      this.children.push(child);
    }
    setAttribute(name, value) {
      this.attributes[name] = value;
    }
    remove() {
      if (!this.parent) return;
      this.parent.children = this.parent.children.filter((child) => child !== this);
      this.parent = null;
    }
    get childElementCount() {
      return this.children.length;
    }
  }

  const body = new Element('body');
  const findById = (node, id) => node.id === id
    ? node
    : node.children.map((child) => findById(child, id)).find(Boolean);
  const documentRef = {
    body,
    createElement: (tagName) => new Element(tagName),
    getElementById: (id) => findById(body, id),
  };

  const first = mountExtensionNotification(documentRef, { message: 'Open https://example.test', notifyType: 'info' });
  const second = mountExtensionNotification(documentRef, { message: 'Login failed', notifyType: 'error' });
  const region = documentRef.getElementById('extension-notifications');
  assert.equal(region.parent, body);
  assert.equal(region.childElementCount, 2);
  assert.equal(first.notification.attributes.role, 'status');
  assert.match(first.notification.children[0].innerHTML, /<a href="https:\/\/example\.test"/);
  assert.equal(second.notification.attributes.role, 'alert');
  assert.equal(first.notification.children[1].attributes['aria-label'], 'Dismiss notification');
  first.dismiss();
  assert.equal(region.parent, body);
  second.dismiss();
  assert.equal(region.parent, null);

  const css = fs.readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
  const zIndex = (selector) => Number(css.match(new RegExp(`${selector} \\{[^}]*z-index: (\\d+)`, 's'))[1]);
  assert.ok(zIndex('\\.settings-panel') < zIndex('#dialog-container'));
  assert.ok(zIndex('#dialog-container') < zIndex('#extension-notifications'));
  const regionCss = css.match(/#extension-notifications \{([^}]*)\}/s)[1];
  assert.match(regionCss, /max-height:/);
  assert.match(regionCss, /overflow-y: auto/);
});
