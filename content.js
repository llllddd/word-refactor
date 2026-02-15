(async function() {
  const WORD_PATTERN = /\p{L}+/gu;
  const url = chrome.runtime.getURL('wordsfrequency.json');
  const HIGHLIGHT_CLASS = 'no-highlight-word';
  const TOOLTIP_CLASS = 'no-highlight-tooltip';
  const TOOLTIP_VISIBLE_CLASS = 'is-visible';
  const ACTION_BTN_CLASS = 'no-highlight-action-btn';
  const DISABLED_WORDS_KEY = 'disabledWords';
  const DISABLED_LEVELS_KEY = 'disabledLevels';
  const LEVEL_COLORS = {
    500: '#26a69a',
    1500: '#42a5f5',
    3000: '#ffa726',
    5000: '#ef5350'
  };

  try {
    const [disabledWords, disabledLevels] = await Promise.all([
      loadDisabledWords(),
      loadDisabledLevels()
    ]);
    const data = await loadDictionaryWithRetry(url);
    const allLevels = getAllLevels(data);
    const levelCounts = getLevelCounts(data);
    let matcher = buildMatcher(data, WORD_PATTERN, disabledWords, disabledLevels);

    const refreshHighlights = () => {
      clearAllHighlights();
      matcher = buildMatcher(data, WORD_PATTERN, disabledWords, disabledLevels);
      highlightText(document.body, matcher, WORD_PATTERN);
      renderRestorePanel();
    };

    const renderRestorePanel = setupRestorePanel(
      disabledWords,
      disabledLevels,
      allLevels,
      levelCounts,
      async (normalizedWord) => {
        disabledWords.delete(normalizedWord);
        await saveDisabledWords(disabledWords);
        refreshHighlights();
      },
      async (level, enabled) => {
        if (enabled) {
          disabledLevels.delete(level);
        } else {
          disabledLevels.add(level);
        }
        await saveDisabledLevels(disabledLevels);
        refreshHighlights();
      }
    );

    setupTooltipInteractions(disabledWords, async (normalizedWord) => {
      disabledWords.add(normalizedWord);
      await saveDisabledWords(disabledWords);
      refreshHighlights();
    });

    highlightText(document.body, matcher, WORD_PATTERN);
  } catch (error) {
    console.error('挪威语插件加载失败:', error);
  }

  async function loadDictionary(resourceUrl) {
    const response = await fetch(resourceUrl, { cache: 'no-store' });
    const text = await response.text();

    if (!response.ok) {
      throw new Error(`词库请求失败: ${response.status} ${response.statusText}`);
    }

    if (!text.trim()) {
      throw new Error('词库为空: wordsfrequency.json 内容为空或未读取到内容');
    }

    try {
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed)) {
        throw new Error('词库根节点不是数组');
      }
      return parsed;
    } catch (error) {
      const preview = text.slice(0, 120).replace(/\s+/g, ' ');
      throw new Error(`词库 JSON 解析失败: ${error.message}; 长度=${text.length}; 片段="${preview}"`);
    }
  }

  async function loadDictionaryWithRetry(resourceUrl) {
    try {
      return await loadDictionary(resourceUrl);
    } catch (firstError) {
      const retryUrl = `${resourceUrl}${resourceUrl.includes('?') ? '&' : '?'}t=${Date.now()}`;
      try {
        return await loadDictionary(retryUrl);
      } catch (retryError) {
        throw new Error(`${firstError.message}; 重试失败: ${retryError.message}`);
      }
    }
  }

  function normalizePhrase(raw, wordPattern) {
    if (!raw) return '';
    const cleaned = String(raw)
      .toLowerCase()
      .replace(/\([^)]*\)/g, ' ');
    const tokens = cleaned.match(wordPattern);
    if (!tokens || tokens.length === 0) return '';
    return tokens.join(' ');
  }

  async function loadDisabledWords() {
    try {
      const result = await chrome.storage.local.get([DISABLED_WORDS_KEY]);
      const list = Array.isArray(result[DISABLED_WORDS_KEY]) ? result[DISABLED_WORDS_KEY] : [];
      return new Set(list.map((item) => normalizePhrase(item, WORD_PATTERN)).filter(Boolean));
    } catch (error) {
      console.warn('读取黑名单失败，已回退为空列表:', error);
      return new Set();
    }
  }

  async function saveDisabledWords(disabledWords) {
    await chrome.storage.local.set({
      [DISABLED_WORDS_KEY]: [...disabledWords]
    });
  }

  async function loadDisabledLevels() {
    try {
      const result = await chrome.storage.local.get([DISABLED_LEVELS_KEY]);
      const list = Array.isArray(result[DISABLED_LEVELS_KEY]) ? result[DISABLED_LEVELS_KEY] : [];
      return new Set(
        list
          .map((value) => Number(value))
          .filter((value) => Number.isFinite(value))
      );
    } catch (error) {
      console.warn('读取 level 设置失败，已回退为空列表:', error);
      return new Set();
    }
  }

  async function saveDisabledLevels(disabledLevels) {
    await chrome.storage.local.set({
      [DISABLED_LEVELS_KEY]: [...disabledLevels]
    });
  }

  function setupTooltipInteractions(disabledWords, onDisableWord) {
    const tooltip = document.createElement('div');
    tooltip.className = TOOLTIP_CLASS;
    tooltip.setAttribute('role', 'dialog');
    tooltip.setAttribute('aria-hidden', 'true');
    const textEl = document.createElement('div');
    textEl.className = `${TOOLTIP_CLASS}-text`;
    const disableBtn = document.createElement('button');
    disableBtn.className = `${TOOLTIP_CLASS}-disable`;
    disableBtn.type = 'button';
    disableBtn.textContent = '取消高亮此词';
    tooltip.appendChild(textEl);
    tooltip.appendChild(disableBtn);
    document.body.appendChild(tooltip);

    const actionBtn = document.createElement('button');
    actionBtn.type = 'button';
    actionBtn.className = ACTION_BTN_CLASS;
    actionBtn.textContent = '?';
    actionBtn.setAttribute('aria-label', '打开单词操作');
    document.body.appendChild(actionBtn);

    let activeMark = null;
    let activeNormalizedWord = '';
    let actionMark = null;
    let actionVisible = false;

    function closeTooltip() {
      tooltip.classList.remove(TOOLTIP_VISIBLE_CLASS);
      tooltip.setAttribute('aria-hidden', 'true');
      if (activeMark) {
        activeMark.classList.remove('is-active');
        activeMark = null;
      }
      activeNormalizedWord = '';
    }

    function showActionButton(mark) {
      if (!mark) return;
      actionMark = mark;
      const rect = mark.getBoundingClientRect();
      const top = rect.top + window.scrollY - 8;
      const left = rect.right + window.scrollX - 8;
      actionBtn.style.top = `${top}px`;
      actionBtn.style.left = `${left}px`;
      actionBtn.classList.add('is-visible');
      actionVisible = true;
    }

    function hideActionButton() {
      actionBtn.classList.remove('is-visible');
      actionVisible = false;
      actionMark = null;
    }

    function openTooltip(mark) {
      const meaning = mark.dataset.meaning || '未知含义';
      const word = mark.textContent || '';
      const level = mark.dataset.level || '';
      activeNormalizedWord = normalizePhrase(word, WORD_PATTERN);
      textEl.textContent = `${word}${level ? ` (L${level})` : ''}: ${meaning}`;
      tooltip.classList.add(TOOLTIP_VISIBLE_CLASS);
      tooltip.setAttribute('aria-hidden', 'false');
      disableBtn.disabled = !activeNormalizedWord;

      if (activeMark && activeMark !== mark) {
        activeMark.classList.remove('is-active');
      }
      activeMark = mark;
      activeMark.classList.add('is-active');

      const rect = mark.getBoundingClientRect();
      const top = rect.bottom + window.scrollY + 8;
      const left = rect.left + window.scrollX;
      tooltip.style.top = `${top}px`;
      tooltip.style.left = `${left}px`;
    }

    document.addEventListener('mouseover', (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const mark = target.closest(`mark.${HIGHLIGHT_CLASS}`);
      if (mark) {
        showActionButton(mark);
      }
    });

    document.addEventListener('click', (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;

      const mark = target.closest(`mark.${HIGHLIGHT_CLASS}`);
      if (mark) {
        event.preventDefault();
        event.stopPropagation();
        showActionButton(mark);
        return;
      }

      if (target.closest(`.${TOOLTIP_CLASS}`) || target.closest(`.${ACTION_BTN_CLASS}`)) {
        return;
      }

      closeTooltip();
      hideActionButton();
    }, true);

    actionBtn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!actionMark) return;
      openTooltip(actionMark);
    });

    disableBtn.addEventListener('click', async () => {
      if (!activeNormalizedWord) return;
      disabledWords.add(activeNormalizedWord);
      await onDisableWord(activeNormalizedWord);
      closeTooltip();
      hideActionButton();
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        closeTooltip();
      }
    });

    window.addEventListener('scroll', () => {
      if (actionVisible && actionMark) {
        const actionRect = actionMark.getBoundingClientRect();
        actionBtn.style.top = `${actionRect.top + window.scrollY - 8}px`;
        actionBtn.style.left = `${actionRect.right + window.scrollX - 8}px`;
      }
      if (!activeMark || !tooltip.classList.contains(TOOLTIP_VISIBLE_CLASS)) return;
      const rect = activeMark.getBoundingClientRect();
      tooltip.style.top = `${rect.bottom + window.scrollY + 8}px`;
      tooltip.style.left = `${rect.left + window.scrollX}px`;
    }, { passive: true });
  }

  function setupRestorePanel(
    disabledWords,
    disabledLevels,
    allLevels,
    levelCounts,
    onRestoreWord,
    onLevelToggle
  ) {
    const container = document.createElement('div');
    container.className = 'no-highlight-manager';
    container.style.position = 'fixed';
    container.style.right = '16px';
    container.style.bottom = '16px';
    container.style.zIndex = '2147483646';
    container.style.fontFamily = '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'no-highlight-manager-trigger';
    trigger.textContent = '高亮设置';

    const panel = document.createElement('div');
    panel.className = 'no-highlight-manager-panel';
    panel.setAttribute('aria-hidden', 'true');

    const levelTitle = document.createElement('div');
    levelTitle.className = 'no-highlight-manager-title';
    levelTitle.textContent = 'Level 开关';

    const levelsList = document.createElement('div');
    levelsList.className = 'no-highlight-manager-levels';

    const wordTitle = document.createElement('div');
    wordTitle.className = 'no-highlight-manager-title';
    wordTitle.textContent = '已取消高亮';

    const wordsList = document.createElement('div');
    wordsList.className = 'no-highlight-manager-list';

    panel.appendChild(levelTitle);
    panel.appendChild(levelsList);
    panel.appendChild(wordTitle);
    panel.appendChild(wordsList);
    container.appendChild(trigger);
    container.appendChild(panel);
    document.body.appendChild(container);

    function renderLevels() {
      levelsList.innerHTML = '';

      allLevels.forEach((level) => {
        const row = document.createElement('label');
        row.className = 'no-highlight-manager-level-row';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = !disabledLevels.has(level);
        checkbox.addEventListener('change', async () => {
          checkbox.disabled = true;
          await onLevelToggle(level, checkbox.checked);
          checkbox.disabled = false;
          renderLevels();
        });

        const swatch = document.createElement('span');
        swatch.className = 'no-highlight-manager-level-swatch';
        swatch.style.background = getLevelColor(level);

        const label = document.createElement('span');
        label.className = 'no-highlight-manager-level-text';
        const count = levelCounts.get(level) || 0;
        label.textContent = `L${level} (${count})`;

        row.appendChild(checkbox);
        row.appendChild(swatch);
        row.appendChild(label);
        levelsList.appendChild(row);
      });
    }

    function renderWords() {
      wordsList.innerHTML = '';
      const words = [...disabledWords].sort((a, b) => a.localeCompare(b));

      if (words.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'no-highlight-manager-empty';
        empty.textContent = '暂无已屏蔽单词';
        wordsList.appendChild(empty);
        return;
      }

      words.forEach((word) => {
        const row = document.createElement('div');
        row.className = 'no-highlight-manager-item';

        const wordEl = document.createElement('span');
        wordEl.className = 'no-highlight-manager-word';
        wordEl.textContent = word;

        const restoreBtn = document.createElement('button');
        restoreBtn.type = 'button';
        restoreBtn.className = 'no-highlight-manager-restore';
        restoreBtn.textContent = '恢复高亮';
        restoreBtn.addEventListener('click', async () => {
          await onRestoreWord(word);
          renderWords();
        });

        row.appendChild(wordEl);
        row.appendChild(restoreBtn);
        wordsList.appendChild(row);
      });
    }

    function renderPanel() {
      renderLevels();
      renderWords();
    }

    trigger.addEventListener('click', () => {
      const nextVisible = !panel.classList.contains('is-visible');
      panel.classList.toggle('is-visible', nextVisible);
      panel.setAttribute('aria-hidden', nextVisible ? 'false' : 'true');
      panel.style.opacity = nextVisible ? '1' : '0';
      panel.style.pointerEvents = nextVisible ? 'auto' : 'none';
      panel.style.transform = nextVisible ? 'translateY(0)' : 'translateY(4px)';
      if (nextVisible) renderPanel();
    });

    document.addEventListener('click', (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest('.no-highlight-manager')) return;
      panel.classList.remove('is-visible');
      panel.setAttribute('aria-hidden', 'true');
      panel.style.opacity = '0';
      panel.style.pointerEvents = 'none';
      panel.style.transform = 'translateY(4px)';
    });

    return renderPanel;
  }

  function buildMatcher(data, wordPattern, disabledWords, disabledLevels) {
    const index = new Map();
    let size = 0;

    function addPhrase(rawPhrase, meaning, level) {
      const normalized = normalizePhrase(rawPhrase, wordPattern);
      if (!normalized) return;
      if (disabledWords.has(normalized)) return;
      if (disabledLevels.has(level)) return;

      const tokens = normalized.split(' ');
      const firstToken = tokens[0];
      const phraseLength = tokens.length;
      let firstTokenMap = index.get(firstToken);

      if (!firstTokenMap) {
        firstTokenMap = {
          byLength: new Map(),
          lengthsDesc: []
        };
        index.set(firstToken, firstTokenMap);
      }

      let phrases = firstTokenMap.byLength.get(phraseLength);
      if (!phrases) {
        phrases = new Map();
        firstTokenMap.byLength.set(phraseLength, phrases);
        firstTokenMap.lengthsDesc.push(phraseLength);
        firstTokenMap.lengthsDesc.sort((a, b) => b - a);
      }

      if (phrases.has(normalized)) return;
      phrases.set(normalized, {
        meaning: meaning || '',
        level
      });
      size += 1;
    }

    data.forEach((item) => {
      const meaning = item.meaning || '';
      const level = Number(item.level) || 0;
      addPhrase(item.word, meaning, level);

      if (item.inflection) {
        item.inflection.split(/[,;，]/).forEach((variant) => {
          addPhrase(variant, meaning, level);
        });
      }
    });

    return { index, size };
  }

  function tokenizeText(text, wordPattern) {
    const tokenRegex = new RegExp(wordPattern.source, wordPattern.flags);
    const tokens = [];
    let match;

    while ((match = tokenRegex.exec(text)) !== null) {
      tokens.push({
        word: match[0].toLowerCase(),
        start: match.index,
        end: tokenRegex.lastIndex
      });
    }

    return tokens;
  }

  function findMatches(text, matcher, wordPattern) {
    const tokens = tokenizeText(text, wordPattern);
    if (tokens.length === 0) return [];

    const matches = [];
    let i = 0;

    while (i < tokens.length) {
      const token = tokens[i];
      const firstTokenMap = matcher.index.get(token.word);

      if (!firstTokenMap) {
        i += 1;
        continue;
      }

      let matched = false;

      for (const phraseLength of firstTokenMap.lengthsDesc) {
        if (i + phraseLength > tokens.length) continue;

        const phrase = tokens
          .slice(i, i + phraseLength)
          .map((entry) => entry.word)
          .join(' ');
        const entry = firstTokenMap.byLength.get(phraseLength).get(phrase);

        if (!entry) continue;

        matches.push({
          start: tokens[i].start,
          end: tokens[i + phraseLength - 1].end,
          meaning: entry.meaning || '',
          level: entry.level || 0
        });

        i += phraseLength;
        matched = true;
        break;
      }

      if (!matched) {
        i += 1;
      }
    }

    return matches;
  }

  function highlightText(root, matcher, wordPattern) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        const tag = parent.tagName;
        const blocked =
          tag === 'SCRIPT' ||
          tag === 'STYLE' ||
          tag === 'TEXTAREA' ||
          tag === 'INPUT';
        const inHighlighted = Boolean(parent.closest('mark.no-highlight-word'));
        const inManager = Boolean(parent.closest('.no-highlight-manager'));
        const inTooltip = Boolean(parent.closest('.no-highlight-tooltip'));

        if (blocked || inHighlighted || inManager || inTooltip || !node.nodeValue || !node.nodeValue.trim()) {
          return NodeFilter.FILTER_REJECT;
        }

        return NodeFilter.FILTER_ACCEPT;
      }
    });

    const jobs = [];

    while (walker.nextNode()) {
      const node = walker.currentNode;
      const matches = findMatches(node.nodeValue, matcher, wordPattern);
      if (matches.length > 0) {
        jobs.push({ node, matches });
      }
    }

    jobs.forEach(({ node, matches }) => {
      const parent = node.parentNode;
      if (!parent) return;

      const text = node.nodeValue;
      const fragment = document.createDocumentFragment();
      let lastIndex = 0;

      matches.forEach((match) => {
        fragment.appendChild(document.createTextNode(text.slice(lastIndex, match.start)));

        const mark = document.createElement('mark');
        mark.className = `${HIGHLIGHT_CLASS} no-highlight-level-${match.level}`;
        mark.textContent = text.slice(match.start, match.end);
        mark.dataset.meaning = match.meaning || '';
        mark.dataset.level = String(match.level || '');
        mark.tabIndex = 0;
        mark.setAttribute('role', 'button');
        mark.setAttribute('aria-label', `查看释义: ${mark.textContent}`);

        fragment.appendChild(mark);
        lastIndex = match.end;
      });

      fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
      parent.replaceChild(fragment, node);
    });
  }

  function clearAllHighlights() {
    document.querySelectorAll(`mark.${HIGHLIGHT_CLASS}`).forEach((mark) => {
      mark.replaceWith(document.createTextNode(mark.textContent || ''));
    });
  }

  function getAllLevels(data) {
    return [...new Set(
      data
        .map((item) => Number(item.level))
        .filter((level) => Number.isFinite(level) && level > 0)
    )].sort((a, b) => a - b);
  }

  function getLevelCounts(data) {
    const map = new Map();
    data.forEach((item) => {
      const level = Number(item.level);
      if (!Number.isFinite(level) || level <= 0) return;
      map.set(level, (map.get(level) || 0) + 1);
    });
    return map;
  }

  function getLevelColor(level) {
    return LEVEL_COLORS[level] || '#9e9e9e';
  }
})();
