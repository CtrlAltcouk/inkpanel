import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { renderHtml } from '../../src/render/template.ts';
import { renderMiniHtml } from '../../src/render/miniTemplate.ts';
import { WFT0583, SSD1681_200X200 } from '../../src/panel/profile.ts';
import { dashboardData } from '../fixtures/dashboard.ts';
import { existingWidgets } from '../fixtures/existingWidgets.ts';

// Captured from ha.9 (658b61e) before the additive Sensors renderer dispatch.
const baseline: Record<string, string[]> = {
  calendar: ['797dd3d52721d0339ca3a89f766510780bbd42cd849483679e1064d970657165', '5db253046d99ba455e0c9a1b4c5b424fbce9cfa8d880d0edc368b2a7dfb91ea1'],
  weather: ['210f3d6dd5f8a07112521a18a830a0e9ae86b35bed56a5e1b9ecf169ad1fcdb3', '938d3be5361245559d4fd5deefafadfaeb839fa2579bd34333541d5159fdcf9d'],
  trains: ['1850e92d8cd1742b9f702c4af8abb40927fbcdc491c70805f68f640622284ed9', 'f540d61683b5ad27bf80927ca592bc88294cb4c0aa4df96b9f575890aa0d7ad4'],
  bus: ['18e667d239cafba3011299a6f7a01a2b6374d4215541b1370e3fab68b50a082e', '56fd331982f894ce6b80d81730e62d4b947005ca190da180283b7b5f6d0e6bff'],
  traffic: ['594ea293190a6cf853211588eb48080ae5a1e8753ee8cd2fe0c9afe9cd939664', 'd3072e29ad1ea9ae2c4e628b1b0c3d7c72dda4c49a7693dd60308dcb0d70d0c5'],
  octopus: ['6c1e9bce3056c3de4677892a2757af2077e4818ab4f179a26feae05dfe301bad', 'aa9c4a7032d08ac950fee269241a594b9ef579fe7f356dc16a2366686aeb042f'],
  todo: ['cf5bd60ab3d5346a133d2aff3ffaffd4d62de4452d130fa8d0ab3b7cfb4a38f3', 'f5da3f99024cf0798a5fa0c88929009dd0a74fe3c9fb1089b94f5d050f757e0b'],
  bins: ['85c7e584887c4fc29b0306333bd98f7a74c9d91e2bf92c2fde357e0b0c628d74', 'e529b1840b2ebec1b9a14e24e2a57ed6e1b501154b354b2ec990d4ec0266d8b2'],
  printers: ['2b9740d7898c729aa47a7c52feb4e3707bbb5a72990612b6eff4fa2f2c3c75b6', 'f1766e0237e35684b3ff539ad2aa68e89dca9f16accb73241420c562c142a3e0'],
  empty: ['7456ebe7918351c8bf4ab243311a2d1d704fdd522bbcdb4a282b9af43f6ee09e', '69fec23d167fd243f7198c117c3f550dce8e1d0811905e82312a7b7af1a6970f'],
};

test('every existing full-size/Mini widget retains byte-identical ha.9 HTML/CSS', () => {
  for (const section of existingWidgets()) {
    const full = dashboardData(); full.sections[0] = section;
    const output = [renderHtml(full, WFT0583, ''), renderMiniHtml({ ...full, sections: [section] }, SSD1681_200X200, '')];
    assert.deepEqual(output.map((html) => createHash('sha256').update(html).digest('hex')), baseline[section.type], section.type);
    for (const html of output) assert.doesNotMatch(html, /entities-(full|mini)/);
  }
});
