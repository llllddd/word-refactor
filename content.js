(async function() {
  const WORD_PATTERN = /\p{L}+/gu;
  const MAIN_DICTIONARY_URL = chrome.runtime.getURL('wordsdetail.json');
  const MYOWN_DICTIONARY_URL = chrome.runtime.getURL('myown.json');
  const HIGHLIGHT_CLASS = 'no-highlight-word';
  const TOOLTIP_CLASS = 'no-highlight-tooltip';
  const TOOLTIP_VISIBLE_CLASS = 'is-visible';
  const ACTION_BTN_CLASS = 'no-highlight-action-btn';
  const DISABLED_WORDS_KEY = 'disabledWords';
  const DISABLED_LEVELS_KEY = 'disabledLevels';
  const INCLUDE_MYOWN_KEY = 'includeMyOwn';
  const LEVEL_COLORS = {
    500: '#26a69a',
    1500: '#42a5f5',
    3000: '#ffa726',
    5000: '#ef5350'
  };

  try {
    const [disabledWords, disabledLevels, includeMyOwnDefault] = await Promise.all([
      loadDisabledWords(),
      loadDisabledLevels(),
      loadIncludeMyOwn()
    ]);
    const [mainData, myOwnData] = await Promise.all([
      loadDictionaryWithRetry(MAIN_DICTIONARY_URL),
      loadDictionaryOptional(MYOWN_DICTIONARY_URL)
    ]);
    let includeMyOwn = includeMyOwnDefault;
    const allLevels = getAllLevels(mainData);
    const levelCounts = getLevelCounts(mainData);
    let pageLevelStats = createEmptyPageLevelStats();
    let matcher = buildMatcher(
      mergeDictionaryData(mainData, myOwnData, includeMyOwn),
      WORD_PATTERN,
      disabledWords,
      disabledLevels
    );

    const refreshHighlights = () => {
      clearAllHighlights();
      matcher = buildMatcher(
        mergeDictionaryData(mainData, myOwnData, includeMyOwn),
        WORD_PATTERN,
        disabledWords,
        disabledLevels
      );
      pageLevelStats = highlightText(document.body, matcher, WORD_PATTERN);
      renderRestorePanel();
    };

    const renderRestorePanel = setupRestorePanel(
      disabledWords,
      disabledLevels,
      allLevels,
      includeMyOwn,
      levelCounts,
      () => pageLevelStats,
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
      },
      async (enabled) => {
        includeMyOwn = enabled;
        await saveIncludeMyOwn(enabled);
        refreshHighlights();
      }
    );

    setupTooltipInteractions(disabledWords, async (normalizedWord) => {
      disabledWords.add(normalizedWord);
      await saveDisabledWords(disabledWords);
      refreshHighlights();
    });

    pageLevelStats = highlightText(document.body, matcher, WORD_PATTERN);
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
      throw new Error('词库为空: wordsdetail.json 内容为空或未读取到内容');
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

  async function loadDictionaryOptional(resourceUrl) {
    try {
      return await loadDictionaryWithRetry(resourceUrl);
    } catch (error) {
      console.warn('可选词库加载失败，已忽略:', error);
      return [];
    }
  }

  function mergeDictionaryData(mainData, myOwnData, includeMyOwn) {
    if (!includeMyOwn) return mainData;
    return [...mainData, ...myOwnData];
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

  function normalizeInflection(rawInflection) {
    if (typeof rawInflection === 'string') {
      return rawInflection.trim();
    }

    if (Array.isArray(rawInflection)) {
      return rawInflection.map((item) => String(item).trim()).filter(Boolean).join(', ');
    }

    if (rawInflection && typeof rawInflection === 'object') {
      return Object.values(rawInflection)
        .flatMap((value) => (Array.isArray(value) ? value : [value]))
        .map((item) => String(item).trim())
        .filter(Boolean)
        .join(', ');
    }

    return '';
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

  async function loadIncludeMyOwn() {
    try {
      const result = await chrome.storage.local.get([INCLUDE_MYOWN_KEY]);
      const value = result[INCLUDE_MYOWN_KEY];
      return typeof value === 'boolean' ? value : true;
    } catch (error) {
      console.warn('读取自定义词库开关失败，已回退为开启:', error);
      return true;
    }
  }

  async function saveIncludeMyOwn(enabled) {
    await chrome.storage.local.set({
      [INCLUDE_MYOWN_KEY]: Boolean(enabled)
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
      const type = mark.dataset.type || '';
      const inflection = mark.dataset.inflection || '';
      const baseWord = mark.dataset.baseWord || '';
      const ord = mark.dataset.ord || '';
      const word = mark.textContent || '';
      const firstLine = type ? `${type}, ${meaning}` : meaning;
      activeNormalizedWord = normalizePhrase(word, WORD_PATTERN);
      textEl.innerHTML = '';
      if (baseWord) {
        const headerLineEl = document.createElement('div');
        headerLineEl.textContent = `${baseWord}${ord ? ` (${ord})` : ''}`;
        textEl.appendChild(headerLineEl);
      }
      const firstLineEl = document.createElement('div');
      firstLineEl.textContent = firstLine;
      textEl.appendChild(firstLineEl);
      if (inflection) {
        const secondLineEl = document.createElement('div');
        secondLineEl.textContent = inflection;
        textEl.appendChild(secondLineEl);
      }
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
    includeMyOwn,
    levelCounts,
    getPageLevelStats,
    onRestoreWord,
    onLevelToggle,
    onMyOwnToggle
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

    const sourceTitle = document.createElement('div');
    sourceTitle.className = 'no-highlight-manager-title';
    sourceTitle.textContent = '词库开关';

    const sourceList = document.createElement('div');
    sourceList.className = 'no-highlight-manager-levels';

    const wordTitle = document.createElement('div');
    wordTitle.className = 'no-highlight-manager-title';
    wordTitle.textContent = '已取消高亮';

    const wordsList = document.createElement('div');
    wordsList.className = 'no-highlight-manager-list';

    panel.appendChild(levelTitle);
    panel.appendChild(levelsList);
    panel.appendChild(sourceTitle);
    panel.appendChild(sourceList);
    panel.appendChild(wordTitle);
    panel.appendChild(wordsList);
    container.appendChild(trigger);
    container.appendChild(panel);
    document.body.appendChild(container);

    function renderLevels() {
      levelsList.innerHTML = '';
      const pageStats = getPageLevelStats();
      const pageTotal = pageStats.total;

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
        const pageCount = pageStats.byLevel.get(level) || 0;
        const ratio = pageTotal > 0 ? ((pageCount / pageTotal) * 100).toFixed(1) : '0.0';
        label.textContent = `L${level} (${count}) | 页面 ${ratio}% (${pageCount}/${pageTotal})`;

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

    function renderSources() {
      sourceList.innerHTML = '';
      const row = document.createElement('label');
      row.className = 'no-highlight-manager-level-row';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = includeMyOwn;
      checkbox.addEventListener('change', async () => {
        checkbox.disabled = true;
        await onMyOwnToggle(checkbox.checked);
        includeMyOwn = checkbox.checked;
        checkbox.disabled = false;
        renderSources();
      });

      const swatch = document.createElement('span');
      swatch.className = 'no-highlight-manager-level-swatch';
      swatch.style.background = '#ab47bc';

      const label = document.createElement('span');
      label.className = 'no-highlight-manager-level-text';
      label.textContent = '我的单词本';

      row.appendChild(checkbox);
      row.appendChild(swatch);
      row.appendChild(label);
      sourceList.appendChild(row);
    }

    function renderPanel() {
      renderLevels();
      renderSources();
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

    function addPhrase(rawPhrase, meaning, type, inflection, baseWord, ord, level) {
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
        type: type || '',
        inflection: inflection || '',
        baseWord: baseWord || '',
        ord: ord || '',
        level
      });
      size += 1;
    }

    data.forEach((item) => {
      const meaning = item.meaning || '';
      const type = item.type || item.pos || '';
      const inflection = normalizeInflection(item.inflection);
      const baseWord = item.word || '';
      const ord = item.ord || '';
      const level = Number(item.level) || 0;
      addPhrase(baseWord, meaning, type, inflection, baseWord, ord, level);

      if (inflection) {
        inflection.split(/[,;，]/).forEach((variant) => {
          addPhrase(variant, meaning, type, inflection, baseWord, ord, level);
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
          type: entry.type || '',
          inflection: entry.inflection || '',
          baseWord: entry.baseWord || '',
          ord: entry.ord || '',
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
    const pageLevelCounts = new Map();
    let pageMatchedTotal = 0;

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
        if (Number.isFinite(match.level) && match.level > 0) {
          pageLevelCounts.set(match.level, (pageLevelCounts.get(match.level) || 0) + 1);
          pageMatchedTotal += 1;
        }
        fragment.appendChild(document.createTextNode(text.slice(lastIndex, match.start)));

        const mark = document.createElement('mark');
        mark.className = `${HIGHLIGHT_CLASS} no-highlight-level-${match.level}`;
        mark.textContent = text.slice(match.start, match.end);
        mark.dataset.meaning = match.meaning || '';
        mark.dataset.type = match.type || '';
        mark.dataset.inflection = match.inflection || '';
        mark.dataset.baseWord = match.baseWord || '';
        mark.dataset.ord = match.ord || '';
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

    return {
      byLevel: pageLevelCounts,
      total: pageMatchedTotal
    };
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

  function createEmptyPageLevelStats() {
    return {
      byLevel: new Map(),
      total: 0
    };
  }

  function getLevelColor(level) {
    return LEVEL_COLORS[level] || '#9e9e9e';
  }
})();
