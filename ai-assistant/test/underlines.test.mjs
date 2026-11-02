import { describe, expect, it, vi } from 'vitest';
import { diffSuggestions, reviewStep } from '../src/lib/grammar.js';
import { CHECKER_ID, annotationsFromReview, checkText, registerGrammarChecker, showUnderlines } from '../src/lib/underlines.js';

const OBJ = '\uFFFC';
const request = (segments) => ({ revision: 'r1', objectReplacement: OBJ, segments });

describe('annotationsFromReview', () => {
  it('underlines each open suggestion in the paragraph it is in', () => {
    const source = 'Hello Bob,\n\ni has two question about teh offer.';
    const corrected = 'Hello Bob,\n\nI have two questions about the offer.';
    const segments = diffSuggestions(source, corrected);
    const req = request([{ id: 'a', text: 'Hello Bob,' }, { id: 'b', text: 'i has two question about teh offer.' }]);
    const anns = annotationsFromReview(req, source, segments, {}, 'Suggested');
    const words = anns.map((a) => req.segments.find((s) => s.id === a.segmentId).text.slice(a.offset, a.offset + a.length));
    expect(words).toEqual(expect.arrayContaining(['teh']));
    expect(anns.every((a) => a.segmentId === 'b' && a.kind === 'grammar' && a.message === 'Suggested')).toBe(true);
    const teh = anns.find((a) => a.replacements[0] === 'the');
    expect(req.segments[1].text.slice(teh.offset, teh.offset + teh.length)).toBe('teh');
  });

  it('counts the mention and image placeholders the host puts in the paragraph', () => {
    // getBody leaves the mention out; the host's segment has one U+FFFC for it.
    const source = 'Hi , see teh file.';
    const segments = diffSuggestions(source, 'Hi , see the file.');
    const req = request([{ id: 'a', text: `Hi ${OBJ}, see teh file.` }]);
    const [ann] = annotationsFromReview(req, source, segments, {}, 'x');
    expect(req.segments[0].text.slice(ann.offset, ann.offset + ann.length)).toBe('teh');
  });

  it('leaves out suggestions already decided, deletions, insertions and paragraphs it cannot find', () => {
    const source = 'teh cat sat on teh mat';
    const segments = diffSuggestions(source, 'the cat sat on the mat');
    const first = segments.find((s) => s.kind === 'change');
    const { review } = reviewStep({ segments, states: {} }, first.id, 'skipped');
    expect(annotationsFromReview(request([{ id: 'a', text: source }]), source, segments, review.states, 'x')).toHaveLength(1);
    expect(annotationsFromReview(request([{ id: 'a', text: 'something else' }]), source, segments, {}, 'x')).toEqual([]);
    const deletion = diffSuggestions('a very very good day', 'a very good day');
    expect(annotationsFromReview(request([{ id: 'a', text: 'a very very good day' }]), 'a very very good day', deletion, {}, 'x')).toEqual([]);
  });
});

describe('the host calls', () => {
  it('register an on-demand grammar checker, and do nothing on an older Bulwark', async () => {
    const registerChecker = vi.fn(async () => ({}));
    expect(await registerGrammarChecker({ composer: { registerChecker } }, 'AI assistant')).toBe(true);
    expect(registerChecker).toHaveBeenCalledWith({ id: CHECKER_ID, label: 'AI assistant', kinds: ['grammar'], mode: 'on-demand' });
    expect(await registerGrammarChecker({ composer: {} }, 'AI assistant')).toBe(false);
    expect(await checkText({ composer: {} }, 'c1')).toBeNull();
  });

  it('push the annotations with the revision of the text they were made for', async () => {
    const setAnnotations = vi.fn(async () => 1);
    const source = 'teh cat';
    const review = { segments: diffSuggestions(source, 'the cat'), states: {} };
    await showUnderlines({ composer: { setAnnotations } }, 'c1', request([{ id: 'a', text: source }]), source, review, 'x');
    expect(setAnnotations).toHaveBeenCalledWith('c1', CHECKER_ID, 'r1', [expect.objectContaining({ segmentId: 'a', offset: 0, length: 3, replacements: ['the'] })]);
  });

  it('give no text where checking is off', async () => {
    const getCheckText = vi.fn(async () => { throw new Error('checking_off'); });
    expect(await checkText({ composer: { getCheckText } }, 'c1')).toBeNull();
  });
});
