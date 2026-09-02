---
description: "Assistant prose must stay in the user's language (Chinese here, English when the task is English) — never drift into an unrelated third language"
condition:
  - '(?i)(?<!`[^`\n]{0,200})(?:^|[\s\"“”«>(\[])(?:der|die|das|des|dem|den|ein|eine|einen|nicht|noch|aber|jetzt|schon|damit|sondern|wurde|werden|müssen|können|ich|wir|und|oder|auch|sehr|ist|sind|war|hat|habe|kein|keine|weil|dass|nach|beim|über|zum|zur|mit|von)(?=[\s,.:;!?…)\]\"”]|$)[^`\n]{0,120}?[\s"“”«>(\[](?:der|die|das|des|dem|den|ein|eine|einen|nicht|noch|aber|jetzt|schon|damit|sondern|wurde|werden|müssen|können|ich|wir|und|oder|auch|sehr|ist|sind|war|hat|habe|kein|keine|weil|dass|nach|beim|über|zum|zur|mit|von)(?=[\s,.:;!?…)\]\"”]|$)'
  - '(?i)(?<!`[^`\n]{0,200})(?:^|[\s\"“”«>(\[])(?:le|la|les|des|une|nous|vous|pas|mais|donc|avec|pour|dans|est|sont|été|être|cette|qui|plus|très|elle|leur|comme|faut)(?=[\s,.:;!?…)\]\"”]|$)[^`\n]{0,120}?[\s"“”«>(\[](?:le|la|les|des|une|nous|vous|pas|mais|donc|avec|pour|dans|est|sont|été|être|cette|qui|plus|très|elle|leur|comme|faut)(?=[\s,.:;!?…)\]\"”]|$)'
  - '(?i)(?<!`[^`\n]{0,200})(?:^|[\s\"“”«>(\[])(?:el|los|las|una|unos|nosotros|pero|porque|también|está|están|hay|muy|entonces|para|con|del|desde|cuando|aunque|siempre|puede)(?=[\s,.:;!?…)\]\"”]|$)[^`\n]{0,120}?[\s"“”«>(\[](?:el|los|las|una|unos|nosotros|pero|porque|también|está|están|hay|muy|entonces|para|con|del|desde|cuando|aunque|siempre|puede)(?=[\s,.:;!?…)\]\"”]|$)'
  - '(?<!`[^`\n]{0,200})[ぁ-んァ-ヶ]{2,}'
  - '(?<!`[^`\n]{0,200})[가-힣]{2,}'
scope: "text, thinking"
interruptMode: always
---

## 回复语言纪律

用用户的语言回答：本会话是中文，正文就必须是中文；只有当任务语境本身以英文为主（英文仓库文档、commit message、上游 issue 原文）时才整段用英文。

绝不使用用户从未用过的第三种语言 —— 德语、法语、西班牙语、日语、韩语。那是不可读的噪音，会逼用户重问一遍。

- 写到一半发现语言漂移 → 停下，整条消息用中文重写，不要中途切换。
- 技术标识符保持原样：`--timeout`、`IdentityRuntime`、`conftest.py`、报错原文。只有包裹它们的叙述文字必须是中文。
- 必须引用外语原文（报错、上游文档）时，把它放进反引号，叙述仍然用中文；反引号里的内容不触发本规则。

错误：`Kurze Antwort: nein, das ist nicht normal — das war ein Hänger.`

正确：简短回答：不正常，这是卡住了。问题：重构只做了一半，`tests/conftest.py` 仍在构造 `object.__new__(OctoAdapter)`，但身份状态已经搬到 `IdentityRuntime`。
