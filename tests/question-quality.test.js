const test = require('node:test');
const assert = require('node:assert/strict');
const {
  getSimilarity,
  isNearDuplicate,
  filterNovelItems
} = require('../public/question-quality');

// 以下数字为合成测试数据，不代表真实业务指标。
test('识别换了说法的同一个问题', () => {
  const first = '500个回扫池里，AI怎么判断今天该联系谁、不该联系谁？';
  const second = '500个客户的回扫池，AI怎么决定今天先联系谁、跳过谁？';
  assert.ok(getSimilarity(first, second) >= 0.56);
  assert.equal(isNearDuplicate(second, [first]), true);
});

test('保留同一主题下不同证据目标的问题', () => {
  const first = '15%激活率和人工回扫相比是什么水平？';
  const second = 'AI回复70%、人工回复10%，剩下的20%是什么状态？';
  assert.ok(getSimilarity(first, second) < 0.56);
});

test('普通与深度问题共用去重历史', () => {
  const history = ['子工程的本地规范和顶层文档冲突时怎么处理？'];
  const items = [
    { question: '子工程规范与顶层文档冲突时，谁优先？' },
    { question: '一天发十个版本时，付费客户的稳定性靠什么兜底？' }
  ];
  const filtered = filterNovelItems(items, history, item => item.question);
  assert.deepEqual(filtered.map(item => item.question), [items[1].question]);
});
