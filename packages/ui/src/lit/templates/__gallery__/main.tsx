/**
 * Templates gallery (lane B2): one TEST room per template in every state. Query: ?t=<template>&s=<state>
 * &mode=simple|pro &look=lit|flat &dir=rtl &stretch=1 &surfaces=solid &theme=light &accent=blue|ember|...
 * &market=uk|eu|unset. With no `t`, a matrix of links. Dev tool only, never built into the package.
 */
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { templates, type Mode, type TemplateId } from '../../contracts.js';
import type { Market } from '../types.js';
import { setCopyOptions } from './copy.js';
import { ROOMS, galleryStates, type GalleryState } from './fixtures.js';

const q = new URLSearchParams(location.search);
const root = document.documentElement;
if (q.get('look') !== 'flat') root.dataset.look = 'lit';
root.dataset.accent = q.get('accent') ?? 'blue';
if (q.get('theme') === 'light') root.dataset.theme = 'light';
if (q.get('surfaces') === 'solid') root.dataset.surfaces = 'solid';
const mode = (q.get('mode') === 'pro' ? 'pro' : 'simple') as Mode;
root.dataset.mode = mode;
const rtl = q.get('dir') === 'rtl';
if (rtl) {
  root.dir = 'rtl';
  root.lang = 'ar';
}
setCopyOptions({ stretch: q.get('stretch') === '1', rtl });

function Matrix() {
  const ids = Object.keys(templates) as TemplateId[];
  return (
    <main className="gallery-matrix">
      <h1>Lit glass templates, TEST</h1>
      <table>
        <thead>
          <tr>
            <th>Template</th>
            {galleryStates.map((s) => (
              <th key={s}>{s}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {ids.map((id) => (
            <tr key={id}>
              <th>{id}</th>
              {galleryStates.map((s) => (
                <td key={s}>
                  <a href={`?t=${id}&s=${s}`}>Simple</a> · <a href={`?t=${id}&s=${s}&mode=pro`}>Pro</a>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}

function App() {
  const id = q.get('t') as TemplateId | null;
  if (!id || !(id in ROOMS)) return <Matrix />;
  const state = (galleryStates as readonly string[]).includes(q.get('s') ?? '') ? (q.get('s') as GalleryState) : 'ready';
  const market = (q.get('market') ?? 'uk') as Market;
  const Room = ROOMS[id];
  return (
    <div className="gallery-frame" style={{ maxInlineSize: 1440 }}>
      <Room mode={mode} state={state} market={market} />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
