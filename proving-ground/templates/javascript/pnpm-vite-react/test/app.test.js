import { describe, expect, it } from 'vitest';

import { add } from '../src/App.jsx';

describe('App', () => {
  it('adds two numbers', () => {
    expect(add(2, 3)).toBe(5);
  });
});
