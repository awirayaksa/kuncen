import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_RESOURCE_NAME,
  makeResourceLabel,
  resourceLabel,
} from '../src/index';

describe('resource label', () => {
  it('defaults to the DGX Spark when nothing is configured', () => {
    const r = resourceLabel({});
    assert.equal(r.name, DEFAULT_RESOURCE_NAME);
    assert.equal(r.the, 'the DGX Spark');
    assert.equal(r.The, 'The DGX Spark');
  });

  it('takes a name from the environment', () => {
    const r = resourceLabel({ KUNCEN_RESOURCE_NAME: 'staging database' });
    assert.equal(r.The, 'The staging database');
    assert.equal(r.the, 'the staging database');
  });

  it('drops the article for names that stand on their own', () => {
    const r = resourceLabel({ KUNCEN_RESOURCE_NAME: 'Build Server 3', KUNCEN_RESOURCE_ARTICLE: '' });
    assert.equal(r.the, 'Build Server 3', '"the Build Server 3 is free" would be wrong');
    assert.equal(r.The, 'Build Server 3');
  });

  it('accepts a different article', () => {
    const r = resourceLabel({ KUNCEN_RESOURCE_NAME: 'FPGA rig', KUNCEN_RESOURCE_ARTICLE: 'our' });
    assert.equal(r.the, 'our FPGA rig');
    assert.equal(r.The, 'Our FPGA rig');
  });

  it('falls back rather than rendering an empty name', () => {
    assert.equal(resourceLabel({ KUNCEN_RESOURCE_NAME: '   ' }).name, DEFAULT_RESOURCE_NAME);
  });

  it('trims stray whitespace from .env values', () => {
    const r = resourceLabel({ KUNCEN_RESOURCE_NAME: '  Lab GPU  ', KUNCEN_RESOURCE_ARTICLE: ' the ' });
    assert.equal(r.the, 'the Lab GPU');
  });

  it('can be built directly, without the environment', () => {
    assert.equal(makeResourceLabel('licence dongle', 'the').The, 'The licence dongle');
  });
});
