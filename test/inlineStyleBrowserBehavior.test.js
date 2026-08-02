import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'node:test';
import vm from 'node:vm';

class FakeClassList {
  constructor(element) {
    this.element = element;
  }

  add(...names) {
    const classes = new Set(this.element.className.split(/\s+/u).filter(Boolean));
    names.forEach(name => classes.add(name));
    this.element.className = [...classes].join(' ');
  }

  remove(...names) {
    const classes = new Set(this.element.className.split(/\s+/u).filter(Boolean));
    names.forEach(name => classes.delete(name));
    this.element.className = [...classes].join(' ');
  }

  contains(name) {
    return this.element.className.split(/\s+/u).includes(name);
  }
}

class FakeElement {
  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.className = '';
    this.classList = new FakeClassList(this);
    this.dataset = {};
    this.listeners = new Map();
    this.textContent = '';
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  appendChild(child) {
    this.children.push(child);
    child.parentNode = this;
    return child;
  }

  set innerHTML(value) {
    assert.equal(value, '');
    this.children = [];
  }
}

function findByClass(element, className) {
  if (element.classList.contains(className)) return element;
  for (const child of element.children) {
    const match = findByClass(child, className);
    if (match) return match;
  }
  return null;
}

const generalSource = await readFile(
  new URL('../public/js/general.js', import.meta.url),
  'utf8',
);
const resetSectionStart = generalSource.indexOf('////// RESET WIDTH + NAVBAR LOGIC');
const resetSectionEnd = generalSource.indexOf('////// RANDOM FUNCS', resetSectionStart);
assert.ok(resetSectionStart >= 0 && resetSectionEnd > resetSectionStart);
const seasonAndNavigationSource = generalSource.slice(
  resetSectionStart,
  resetSectionEnd,
);

function createGeneralHarness(month, { withNavigation = false } = {}) {
  const domReadyListeners = [];
  const windowListeners = new Map();
  const documentElement = { dataset: {} };
  const body = new FakeElement('body');
  const elements = new Map();

  if (withNavigation) {
    for (const id of [
      'nav-mobile-toggle',
      'nav-links',
      'nav-close-btn',
      'nav-backdrop',
    ]) {
      elements.set(id, new FakeElement('div'));
    }
  }

  const document = {
    body,
    documentElement,
    addEventListener(type, listener) {
      if (type === 'DOMContentLoaded') domReadyListeners.push(listener);
    },
    getElementById(id) {
      return elements.get(id) || null;
    },
  };
  const window = {
    innerWidth: 500,
    addEventListener(type, listener) {
      const listeners = windowListeners.get(type) || [];
      listeners.push(listener);
      windowListeners.set(type, listeners);
    },
  };
  class FixedDate {
    getMonth() {
      return month - 1;
    }
  }

  vm.runInNewContext(seasonAndNavigationSource, {
    Date: FixedDate,
    document,
    window,
  });
  assert.equal(domReadyListeners.length, 1);
  domReadyListeners[0]();

  return { body, documentElement, elements, window, windowListeners };
}

describe('seasonal appearance state', () => {
  test('real general.js month boundaries set one document season safely', () => {
    const expectations = new Map([
      [1, 'winter'],
      [2, 'winter'],
      [3, 'spring'],
      [5, 'spring'],
      [6, 'summer'],
      [8, 'summer'],
      [9, 'autumn'],
      [10, 'autumn'],
      [11, 'winter'],
      [12, 'winter'],
    ]);

    for (const [month, expected] of expectations) {
      const harness = createGeneralHarness(month);
      assert.equal(harness.documentElement.dataset.season, expected, `month ${month}`);
    }
  });

  test('CSS owns all seasonal images and non-home navigation colors', async () => {
    const css = await readFile(
      new URL('../public/css/general.css', import.meta.url),
      'utf8',
    );
    for (const [season, image, color] of [
      ['winter', 'home-hero-winter.jpg', '--winter-color'],
      ['spring', 'home-hero-spring.jpg', '--spring-color'],
      ['summer', 'home-hero-summer.jpg', '--summer-color'],
      ['autumn', 'home-hero-autumn.jpg', '--autumn-color'],
    ]) {
      assert.match(
        css,
        new RegExp(`html\\[data-season="${season}"\\] #home-hero[\\s\\S]*?${image}`, 'u'),
      );
      assert.match(
        css,
        new RegExp(`html\\[data-season="${season}"\\] nav:not\\(\\.home\\) \\.background[\\s\\S]*?var\\(${color}\\)`, 'u'),
      );
    }
  });
});

describe('mobile navigation state', () => {
  test('open, close, and desktop resize toggle the body scroll-lock class', () => {
    const harness = createGeneralHarness(7, { withNavigation: true });
    const toggle = harness.elements.get('nav-mobile-toggle');
    const navLinks = harness.elements.get('nav-links');
    const close = harness.elements.get('nav-close-btn');
    const backdrop = harness.elements.get('nav-backdrop');

    toggle.listeners.get('click')[0]();
    assert.equal(navLinks.classList.contains('open'), true);
    assert.equal(backdrop.classList.contains('visible'), true);
    assert.equal(harness.body.classList.contains('nav-scroll-locked'), true);

    close.listeners.get('click')[0]();
    assert.equal(navLinks.classList.contains('open'), false);
    assert.equal(backdrop.classList.contains('visible'), false);
    assert.equal(harness.body.classList.contains('nav-scroll-locked'), false);

    toggle.listeners.get('click')[0]();
    harness.window.innerWidth = 769;
    harness.windowListeners.get('resize')[0]();
    assert.equal(navLinks.classList.contains('open'), false);
    assert.equal(backdrop.classList.contains('visible'), false);
    assert.equal(harness.body.classList.contains('nav-scroll-locked'), false);
  });
});

describe('all-parks result rendering', () => {
  test('real populateParkList assigns province semantics without style APIs', async () => {
    const source = await readFile(
      new URL('../public/js/allParks.js', import.meta.url),
      'utf8',
    );
    const start = source.indexOf('function populateParkList(provinceName)');
    const end = source.indexOf('// HOVER HIGHLIGHT HELPERS', start);
    assert.ok(start >= 0 && end > start);
    const functionSource = source.slice(start, end);

    const parkList = new FakeElement('div');
    const document = {
      createElement: tagName => new FakeElement(tagName),
      querySelector(selector) {
        return selector === '#park-list' ? parkList : null;
      },
    };
    const context = {
      document,
      parkIcon: {},
      parkIconHighlight: {},
      parkIdToMarker: {},
      parksByProvince: {
        Ontario: [{
          _id: 'park-id',
          image: '/images/park.jpg',
          name: 'Test Park',
          province: 'Ontario',
          slug: '/park/test-park',
        }],
      },
    };
    vm.runInNewContext(
      `${functionSource}\nthis.populateParkList = populateParkList;`,
      context,
    );
    context.populateParkList('Ontario');

    assert.equal(parkList.children.length, 1);
    const province = findByClass(parkList, 'all-parks-result-province');
    assert.ok(province);
    assert.equal(province.textContent, 'Ontario');

    const css = await readFile(
      new URL('../public/css/allParks.css', import.meta.url),
      'utf8',
    );
    assert.match(css, /\.all-parks-result-province\s*\{[\s\S]*?font-size:\s*var\(--font-extra-extra-small\)/u);
    assert.match(css, /\.all-parks-result-province\s*\{[\s\S]*?font-weight:\s*normal/u);
  });
});
