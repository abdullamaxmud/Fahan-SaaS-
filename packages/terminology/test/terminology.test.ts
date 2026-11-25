import { describe, expect, it } from 'vitest';
import { isIcd11Code, nameKey, nameKeys, searchIcd } from '../src';

describe('nameKey folds Somali transliteration variants', () => {
  it.each([
    ['Xasan', 'Hasan'],
    ['Maxamed', 'Mohamed'],
    ['Cali', 'Ali'],
    ['Faadumo', 'Fadumo'],
    ['Cabdiraxmaan', 'Abdirahman'],
  ])('%s ≈ %s', (a, b) => {
    expect(nameKey(a)).toBe(nameKey(b));
  });
  it('keeps different names apart', () => {
    expect(nameKey('Hodan')).not.toBe(nameKey('Hibaaq'));
  });
  it('splits full names into keys', () => {
    expect(nameKeys('Faadumo Cali', 'Xasan')).toEqual(['fdm', 'al', 'hsn']);
  });
});

describe('ICD-11', () => {
  it('validates code shape', () => {
    for (const c of ['1F40', 'BA00', '5A11', 'CA40.0']) expect(isIcd11Code(c)).toBe(true);
    for (const c of ['A00', 'J18.9', 'ba00', '1F4O']) expect(isIcd11Code(c)).toBe(false);
  });
  it('searches the starter list', () => {
    expect(searchIcd('malaria')[0]?.code).toBe('1F40');
    expect(searchIcd('BA')[0]?.code).toBe('BA00');
  });
});
