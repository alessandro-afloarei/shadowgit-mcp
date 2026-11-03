import { describe, expect, it } from 'vitest';
import { displayName } from '../src/client-name.js';

describe('displayName', () => {
  it("names the clients the app's setup lists, and keeps a title or an unknown name", () => {
    expect(displayName({ name: 'claude-code' })).toBe('Claude Code');
    expect(displayName({ name: 'cursor-vscode' })).toBe('Cursor');
    expect(displayName({ name: 'claude-ai' })).toBe('Claude Desktop');
    expect(displayName({ name: 'claude-code', title: 'Claude Code (beta)' })).toBe('Claude Code (beta)');
    expect(displayName({ name: 'zed' })).toBe('zed');
  });
});
