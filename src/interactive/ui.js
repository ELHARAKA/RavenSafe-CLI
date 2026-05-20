'use strict';

const config = require('../config');

const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;
const USE_COLOR = Boolean(process.stdout.isTTY) &&
  !process.env.NO_COLOR &&
  process.env.TERM !== 'dumb';
const USE_UNICODE = Boolean(process.stdout.isTTY) &&
  process.env.RAVENSAFE_ASCII !== '1' &&
  process.env.TERM !== 'dumb';

const PALETTE = Object.freeze({
  reset: 0,
  bold: 1,
  dim: 2,
  cyan: 36,
  blue: 34,
  green: 32,
  yellow: 33,
  red: 31,
  gray: 90,
});

const symbols = USE_UNICODE
  ? Object.freeze({
    tl: '╭',
    tr: '╮',
    bl: '╰',
    br: '╯',
    h: '─',
    v: '│',
    prompt: '›',
    info: 'i',
    success: '✓',
    warning: '!',
    error: '×',
    section: '◆',
    bullet: '•',
    frames: ['◐', '◓', '◑', '◒'],
  })
  : Object.freeze({
    tl: '+',
    tr: '+',
    bl: '+',
    br: '+',
    h: '-',
    v: '|',
    prompt: '>',
    info: 'i',
    success: '+',
    warning: '!',
    error: 'x',
    section: '*',
    bullet: '-',
    frames: ['-', '\\', '|', '/'],
  });

function color(code, value) {
  const text = String(value);
  if (!USE_COLOR) {
    return text;
  }

  return `\u001b[${code}m${text}\u001b[0m`;
}

const style = Object.freeze({
  bold: value => color(PALETTE.bold, value),
  dim: value => color(PALETTE.dim, value),
  cyan: value => color(PALETTE.cyan, value),
  blue: value => color(PALETTE.blue, value),
  green: value => color(PALETTE.green, value),
  yellow: value => color(PALETTE.yellow, value),
  red: value => color(PALETTE.red, value),
  gray: value => color(PALETTE.gray, value),
});

function stripAnsi(value) {
  return String(value).replace(ANSI_PATTERN, '');
}

function visibleLength(value) {
  return stripAnsi(value).length;
}

function terminalWidth() {
  if (!process.stdout.isTTY || !Number.isSafeInteger(process.stdout.columns)) {
    return 80;
  }

  return Math.max(40, process.stdout.columns);
}

function repeat(char, count) {
  return char.repeat(Math.max(0, count));
}

function padRight(value, width) {
  return `${value}${repeat(' ', width - visibleLength(value))}`;
}

function hardWrapWord(word, width) {
  if (visibleLength(word) <= width) {
    return [word];
  }

  if (stripAnsi(word) !== word) {
    return [word];
  }

  const chunks = [];
  for (let index = 0; index < word.length; index += width) {
    chunks.push(word.slice(index, index + width));
  }
  return chunks;
}

function wrapLine(line, width) {
  const text = String(line);
  if (text.length === 0) {
    return [''];
  }

  const words = text.split(/\s+/);
  const lines = [];
  let current = '';

  for (const word of words) {
    const chunks = hardWrapWord(word, width);
    for (const chunk of chunks) {
      if (!current) {
        current = chunk;
        continue;
      }

      if (visibleLength(current) + 1 + visibleLength(chunk) <= width) {
        current = `${current} ${chunk}`;
        continue;
      }

      lines.push(current);
      current = chunk;
    }
  }

  if (current) {
    lines.push(current);
  }

  return lines.length > 0 ? lines : [''];
}

function normalizeLines(lines) {
  if (Array.isArray(lines)) {
    return lines.map(line => String(line));
  }

  return String(lines).split('\n');
}

function borderColor(colorName, value) {
  if (colorName && style[colorName]) {
    return style[colorName](value);
  }

  return value;
}

function box(lines, options = {}) {
  const preferredWidth = options.width || 76;
  const maxWidth = Math.min(92, terminalWidth() - 2);
  const width = Math.max(34, Math.min(preferredWidth, maxWidth));
  const contentWidth = width - 4;
  const title = options.title ? ` ${options.title} ` : '';
  const titleLength = visibleLength(title);
  const titleLeft = title ? 2 : 0;
  const horizontalWidth = width - 2;
  const titleRight = title
    ? horizontalWidth - titleLeft - titleLength
    : horizontalWidth;
  const body = [];
  const colorName = options.color || 'cyan';
  const top = title
    ? `${borderColor(colorName, `${symbols.tl}${repeat(symbols.h, titleLeft)}`)}${style.bold(title)}${borderColor(colorName, `${repeat(symbols.h, titleRight)}${symbols.tr}`)}`
    : borderColor(colorName, `${symbols.tl}${repeat(symbols.h, horizontalWidth)}${symbols.tr}`);
  const bottom = borderColor(colorName, `${symbols.bl}${repeat(symbols.h, horizontalWidth)}${symbols.br}`);

  for (const line of normalizeLines(lines)) {
    for (const wrapped of wrapLine(line, contentWidth)) {
      body.push(`${symbols.v} ${padRight(wrapped, contentWidth)} ${symbols.v}`);
    }
  }

  return [
    top,
    ...body.map(line => {
      const left = borderColor(colorName, symbols.v);
      const right = borderColor(colorName, symbols.v);
      return `${left}${line.slice(symbols.v.length, -symbols.v.length)}${right}`;
    }),
    bottom,
  ].join('\n');
}

function printBox(lines, options = {}) {
  console.log(box(lines, options));
}

function clearScreen() {
  if (!process.stdout.isTTY) {
    return;
  }

  process.stdout.write('\u001b[2J\u001b[3J\u001b[H');
}

function sleep(ms) {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

async function bootSequence() {
  if (!process.stdout.isTTY) {
    return;
  }

  const steps = [
    'Preparing guided mode',
    'Loading safety-first interface',
  ];

  for (const step of steps) {
    for (let index = 0; index < 2; index += 1) {
      const frame = symbols.frames[index % symbols.frames.length];
      process.stdout.write(`\r${style.cyan(frame)} ${style.dim(step)}   `);
      await sleep(70);
    }
  }

  process.stdout.write('\r\u001b[2K');
}

async function showStartup() {
  clearScreen();
  await bootSequence();
  printBrandHeader();
  printWelcomeCard();
}

function printBrandHeader() {
  printBox([
    style.bold('RavenSafe CLI'),
    'Secure Ravencoin Ledger Helper',
    style.dim('Ledger signs. Your seed never leaves the device.'),
  ], {
    title: 'Guided Wallet Mode',
    color: 'cyan',
    width: 72,
  });
}

function printWelcomeCard() {
  const rvnDonation = config.branding.donations.rvn;

  console.log('');
  printBox([
    'Scan balances, prepare receive addresses, and send RVN through a guided Ledger workflow.',
    'This tool never asks for a seed phrase, mnemonic, private key, or passphrase.',
    '',
    `Support RVN donations: ${rvnDonation.address}`,
  ], {
    title: 'Welcome',
    color: 'blue',
    width: 72,
  });
}

function section(title, subtitle) {
  console.log('');
  console.log(`${style.cyan(symbols.section)} ${style.bold(title)}`);
  if (subtitle) {
    console.log(style.dim(`  ${subtitle}`));
  }
}

function line(type, message) {
  const colorByType = {
    info: 'blue',
    success: 'green',
    warning: 'yellow',
    error: 'red',
  };
  const symbolByType = {
    info: symbols.info,
    success: symbols.success,
    warning: symbols.warning,
    error: symbols.error,
  };
  const colorName = colorByType[type] || 'blue';
  const marker = style[colorName](symbolByType[type] || symbols.info);
  console.log(`${marker} ${message}`);
}

function info(message) {
  line('info', message);
}

function success(message) {
  line('success', message);
}

function warning(message) {
  line('warning', message);
}

function error(message) {
  line('error', message);
}

function successBox(title, lines) {
  printBox(lines, {
    title,
    color: 'green',
    width: 76,
  });
}

function warningBox(title, lines) {
  printBox(lines, {
    title,
    color: 'yellow',
    width: 76,
  });
}

function errorBox(title, lines) {
  printBox(lines, {
    title,
    color: 'red',
    width: 76,
  });
}

function infoBox(title, lines) {
  printBox(lines, {
    title,
    color: 'blue',
    width: 76,
  });
}

function prompt(label, hint) {
  const suffix = hint ? ` ${style.dim(hint)}` : '';
  return `${style.cyan(symbols.prompt)} ${label}${suffix}: `;
}

function optionRows(items) {
  return items.map(item => {
    const index = style.cyan(String(item.value).padStart(2, ' '));
    const label = style.bold(item.label);
    const description = item.description ? style.dim(` - ${item.description}`) : '';
    return `${index}. ${label}${description}`;
  });
}

function menu(title, items, footer) {
  const lines = optionRows(items);
  if (footer) {
    lines.push('');
    lines.push(style.dim(footer));
  }

  printBox(lines, {
    title,
    color: 'cyan',
    width: 72,
  });
}

function keyValueLines(entries) {
  const labelWidth = Math.max(...entries.map(entry => visibleLength(entry.label)));
  return entries.map(entry => {
    const label = style.dim(padRight(entry.label, labelWidth));
    return `${label}  ${entry.value}`;
  });
}

function keyValueBox(title, entries, options = {}) {
  printBox(keyValueLines(entries), {
    title,
    color: options.color || 'blue',
    width: options.width || 76,
  });
}

async function withSpinner(message, task) {
  if (!process.stdout.isTTY) {
    info(message);
    return task();
  }

  let index = 0;
  process.stdout.write(`${style.cyan(symbols.frames[0])} ${style.dim(message)}`);
  const timer = setInterval(() => {
    index = (index + 1) % symbols.frames.length;
    process.stdout.write(`\r${style.cyan(symbols.frames[index])} ${style.dim(message)}`);
  }, 90);

  try {
    return await task();
  } finally {
    clearInterval(timer);
    process.stdout.write('\r\u001b[2K');
  }
}

module.exports = {
  box,
  clearScreen,
  error,
  errorBox,
  info,
  infoBox,
  keyValueBox,
  keyValueLines,
  menu,
  optionRows,
  printBox,
  prompt,
  section,
  showStartup,
  style,
  success,
  successBox,
  symbols,
  warning,
  warningBox,
  withSpinner,
};
