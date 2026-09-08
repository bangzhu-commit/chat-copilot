(function exposeQuestionQuality(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.ChatCopilotQuestionQuality = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createQuestionQuality() {
  function normalizeQuestion(text) {
    return String(text || '')
      .toLowerCase()
      .replace(/^\s*\[[^\]]+\]\s*/, '')
      .replace(/^(?:你说|你提到|你刚才说|刚才提到|刚才说到)/, '')
      .replace(/子工程(?:各自制定的)?(?:本地)?规范/g, '子工程规范')
      .replace(/(?:项目)?根目录(?:的)?(?:规范|规则|文档)?|顶层(?:文档|规则)/g, '顶层规范')
      .replace(/(?:怎么|如何)(?:判断|决定|选择)|(?:判断|决定)(?:今天)?(?:先)?/g, '选择规则')
      .replace(/(?:该|先)?联系谁/g, '联系对象')
      .replace(/不该联系谁|跳过谁/g, '跳过对象')
      .replace(/(?:冲突时?)?(?:怎么|如何)处理|冲突时?谁优先|冲突时?按哪(?:一)?份执行/g, '冲突优先规则')
      .replace(/(?:具体|到底|当前|现在|这个|一下)/g, '')
      .replace(/(?:今天|其中|最终)/g, '')
      .replace(/[\s\p{P}\p{S}]/gu, '');
  }

  function buildNgrams(text, size = 2) {
    const normalized = normalizeQuestion(text);
    const grams = new Set();
    if (normalized.length < size) {
      if (normalized) grams.add(normalized);
      return grams;
    }
    for (let index = 0; index <= normalized.length - size; index++) {
      grams.add(normalized.slice(index, index + size));
    }
    return grams;
  }

  function getSimilarity(left, right) {
    const normalizedLeft = normalizeQuestion(left);
    const normalizedRight = normalizeQuestion(right);
    if (!normalizedLeft || !normalizedRight) return 0;
    if (normalizedLeft === normalizedRight) return 1;

    const shorter = normalizedLeft.length <= normalizedRight.length ? normalizedLeft : normalizedRight;
    const longer = shorter === normalizedLeft ? normalizedRight : normalizedLeft;
    if (shorter.length >= 12 && longer.includes(shorter)) return 0.92;

    const leftGrams = buildNgrams(normalizedLeft);
    const rightGrams = buildNgrams(normalizedRight);
    let intersection = 0;
    leftGrams.forEach(gram => {
      if (rightGrams.has(gram)) intersection++;
    });
    const union = leftGrams.size + rightGrams.size - intersection;
    const jaccard = union > 0 ? intersection / union : 0;
    const overlap = Math.min(leftGrams.size, rightGrams.size) > 0
      ? intersection / Math.min(leftGrams.size, rightGrams.size)
      : 0;

    if (jaccard >= 0.56) return jaccard;
    if (jaccard >= 0.42 && overlap >= 0.72) return Math.max(jaccard, overlap * 0.8);
    return jaccard;
  }

  function isNearDuplicate(question, history, threshold = 0.56) {
    return (history || []).some(item => {
      const text = typeof item === 'string' ? item : item?.text || item?.question || '';
      return getSimilarity(question, text) >= threshold;
    });
  }

  function filterNovelItems(items, history, getText = item => item?.text || item?.question || '') {
    const accepted = [];
    const comparison = [...(history || [])];
    (items || []).forEach(item => {
      const text = getText(item);
      if (!text || isNearDuplicate(text, comparison)) return;
      accepted.push(item);
      comparison.push(text);
    });
    return accepted;
  }

  return {
    normalizeQuestion,
    getSimilarity,
    isNearDuplicate,
    filterNovelItems
  };
});
