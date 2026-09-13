const {
  Component,
  Menu,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  setIcon,
} = require("obsidian");

const VIDEO_EXTS = ["mp4", "m4v", "mov", "webm", "ogv", "mkv", "avi", "flv", "wmv", "3gp"];
const AUDIO_EXTS = ["mp3", "m4a", "wav", "ogg", "oga", "opus", "flac", "aac", "wma"];
const MEDIA_EXTS = VIDEO_EXTS.concat(AUDIO_EXTS);

const SPEED_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];
const DEFAULT_SETTINGS = { defaultSpeed: 1, rememberSpeed: false, lockRange: true };
const PLAYER_MARK = "media-enhance-0.01";
const KNOWN_KEYS = ["t", "speed", "loop", "no_loop", "autoplay", "no_autoplay", "mute", "no_mute"];

function trimNumber(value) {
  const rounded = Math.round(value * 1000) / 1000;
  return String(rounded);
}

function formatSpeed(speed) {
  return trimNumber(speed) + "×";
}

function formatNPT(seconds) {
  if (seconds == null || !isFinite(seconds)) return "";
  const total = Math.max(0, Math.round(seconds * 10) / 10);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const secsText = (secs < 10 ? "0" : "") + trimNumber(secs);
  const minutesText = (minutes < 10 ? "0" : "") + minutes;
  return hours > 0 ? `${hours}:${minutesText}:${secsText}` : `${minutesText}:${secsText}`;
}

function parseNPT(value) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text || text.toLowerCase() === "e") return null;
  const parts = text.split(":");
  if (parts.length > 3) return null;
  let seconds = 0;
  for (const part of parts) {
    if (!part) return null;
    const num = Number(part);
    if (!isFinite(num) || num < 0) return null;
    seconds = seconds * 60 + num;
  }
  return seconds;
}

function parseTemporal(value) {
  if (value == null) return { start: null, end: null };
  const parts = String(value).split(",");
  const start = parseNPT(parts[0]);
  const end = parts.length > 1 ? parseNPT(parts[1]) : null;
  return { start, end };
}

function parseProps(plugin, subpath) {
  const raw = String(subpath || "").replace(/^#+/, "");
  const query = new URLSearchParams(raw);
  const extra = {};
  query.forEach((value, key) => {
    if (KNOWN_KEYS.indexOf(key) < 0) extra[key] = value;
  });
  const speedValue = Number(query.get("speed"));
  const speed = isFinite(speedValue) && speedValue > 0 ? speedValue : plugin.settings.defaultSpeed;
  const temporal = parseTemporal(query.get("t"));
  return {
    start: temporal.start,
    end: temporal.end,
    speed,
    loop: query.has("loop") && !query.has("no_loop"),
    autoplay: query.has("autoplay") && !query.has("no_autoplay"),
    mute: query.has("mute") && !query.has("no_mute"),
    extra,
    raw,
  };
}

function buildHash(plugin, props) {
  const parts = [];
  const hasStart = props.start != null;
  const hasEnd = props.end != null;
  if (hasStart || hasEnd) {
    if (hasStart && hasEnd) {
      parts.push(`t=${formatNPT(props.start)},${formatNPT(props.end)}`);
    } else if (hasStart) {
      parts.push(`t=${formatNPT(props.start)}`);
    } else {
      parts.push(`t=,${formatNPT(props.end)}`);
    }
  }
  if (Math.abs(props.speed - plugin.settings.defaultSpeed) > 0.0001) {
    parts.push(`speed=${trimNumber(props.speed)}`);
  }
  if (props.loop) parts.push("loop");
  if (props.autoplay) parts.push("autoplay");
  if (props.mute) parts.push("mute");
  for (const key of Object.keys(props.extra || {})) {
    const value = props.extra[key];
    parts.push(value === "" ? key : `${key}=${value}`);
  }
  return parts.join("&");
}

function createEl(tag, className, parent) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (parent) parent.appendChild(element);
  return element;
}

function mediaExtensionFromSrc(src) {
  if (!src) return null;
  let text = String(src);
  const pipeIndex = text.indexOf("|");
  if (pipeIndex >= 0) text = text.slice(0, pipeIndex);
  const hashIndex = text.indexOf("#");
  if (hashIndex >= 0) text = text.slice(0, hashIndex);
  const dotIndex = text.lastIndexOf(".");
  if (dotIndex < 0) return null;
  return text.slice(dotIndex + 1).toLowerCase();
}

async function updateNoteLink(app, sourcePath, file, oldHash, newHash) {
  const noteFile = app.vault.getAbstractFileByPath(sourcePath);
  if (!(noteFile instanceof TFile)) return false;
  const pattern = /(!?)\[\[([^\[\]]+?)\]\]/g;

  function locate(text) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const inner = match[2];
      const pipeIndex = inner.indexOf("|");
      const linkPart = pipeIndex >= 0 ? inner.slice(0, pipeIndex) : inner;
      const hashIndex = linkPart.indexOf("#");
      if (hashIndex < 0) continue;
      const linkPath = linkPart.slice(0, hashIndex);
      const hashPart = linkPart.slice(hashIndex + 1);
      if (hashPart !== oldHash) continue;
      const target = app.metadataCache.getFirstLinkpathDest(linkPath, sourcePath);
      if (target !== file) continue;
      const newInner =
        linkPath + (newHash ? "#" + newHash : "") + (pipeIndex >= 0 ? inner.slice(pipeIndex) : "");
      return {
        start: match.index,
        end: match.index + match[0].length,
        text: match[1] + "[[" + newInner + "]]",
      };
    }
    return null;
  }

  for (const leaf of app.workspace.getLeavesOfType("markdown")) {
    const view = leaf.view;
    if (!view || !view.file || view.file.path !== sourcePath || !view.editor) continue;
    let editing = true;
    if (typeof view.getMode === "function") {
      editing = view.getMode() === "source";
    } else if (typeof view.getState === "function") {
      const state = view.getState();
      editing = !!state && state.mode === "source";
    }
    if (!editing) continue;
    const found = locate(view.editor.getValue());
    if (found) {
      view.editor.replaceRange(
        found.text,
        view.editor.offsetToPos(found.start),
        view.editor.offsetToPos(found.end)
      );
      return true;
    }
  }

  const text = await app.vault.read(noteFile);
  const found = locate(text);
  if (!found) return false;
  await app.vault.modify(noteFile, text.slice(0, found.start) + found.text + text.slice(found.end));
  return true;
}

class ClipEmbed extends Component {
  constructor(plugin, info, file, subpath, opts) {
    super();
    this.plugin = plugin;
    this.app = plugin.app;
    this.info = info;
    this.file = file;
    this.opts = opts || {};
    this.props = parseProps(plugin, subpath);
    this.media = null;
    this.playerEl = null;
    this.rafId = null;
    this.effectiveEnd = this.props.end;
  }

  onload() {
    this.build();
    if (this.plugin.players) this.plugin.players.add(this);
  }

  loadFile() {
    this.build();
  }

  build() {
    const container = this.info && this.info.containerEl;
    if (!container) return;
    if (this.playerEl && this.playerEl.isConnected && container.contains(this.playerEl)) return;
    this.stopTicker();
    this.playerEl = null;
    this.media = null;
    while (container.firstChild) container.removeChild(container.firstChild);
    container.classList.add("mc-embed", "media-embed", "is-loaded");

    const isAudio = AUDIO_EXTS.indexOf(this.file.extension) >= 0;
    const player = createEl("div", isAudio ? "mc-player mc-audio" : "mc-player", container);
    player.setAttribute("data-mc", PLAYER_MARK);
    const media = createEl(isAudio ? "audio" : "video", "mc-media", player);
    media.controls = true;
    media.preload = "metadata";
    media.src = this.app.vault.getResourcePath(this.file);
    media.playbackRate = this.props.speed;
    media.loop = this.props.loop && this.props.start == null && this.props.end == null;
    if (!isAudio) media.setAttribute("playsinline", "");

    this.playerEl = player;
    this.media = media;
    this.effectiveEnd = this.props.end;

    this.registerDomEvent(container, "click", (event) => {
      event.stopImmediatePropagation();
    });
    this.registerDomEvent(player, "contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.showContextMenu(event);
    });
    this.registerDomEvent(media, "loadedmetadata", () => this.handleMetadata());
    this.registerDomEvent(media, "play", () => this.handlePlay());
    this.registerDomEvent(media, "pause", () => this.stopTicker());
    this.registerDomEvent(media, "ended", () => this.handleEnded());
    this.registerDomEvent(media, "timeupdate", () => this.checkRange());
    this.registerDomEvent(media, "seeked", () => this.clampToRange());
    this.registerDomEvent(media, "ratechange", () => this.handleRateChange());

    const toolbar = createEl("div", "mc-toolbar", player);
    if (this.props.start != null || this.props.end != null) {
      const startBtn = createEl("button", "mc-btn mc-start-btn", toolbar);
      startBtn.type = "button";
      startBtn.setAttribute("aria-label", "回到片段起点");
      startBtn.title = "回到片段起点";
      try {
        setIcon(startBtn, "skip-back");
      } catch (error) {
        startBtn.textContent = "⏮";
      }
      startBtn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.jumpToStart();
      });
    }
    const speedBtn = createEl("button", "mc-btn mc-speed-btn", toolbar);
    speedBtn.type = "button";
    speedBtn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.showSpeedMenu(speedBtn);
    });
    this.speedBtn = speedBtn;

    const editBtn = createEl("button", "mc-btn mc-edit-btn", toolbar);
    editBtn.type = "button";
    editBtn.setAttribute("aria-label", "编辑片段参数");
    try {
      setIcon(editBtn, "pencil");
    } catch (error) {
      editBtn.textContent = "✎";
    }
    editBtn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.openEditor();
    });
    if (this.opts.modal) editBtn.remove();

    this.updateSpeedLabel();
  }

  handleMetadata() {
    const media = this.media;
    if (!media) return;
    media.playbackRate = this.props.speed;
    if (this.effectiveEnd != null && isFinite(media.duration)) {
      this.effectiveEnd = Math.min(this.effectiveEnd, media.duration);
    }
    if (isFinite(media.duration) && this.props.start != null) {
      media.currentTime = this.props.start < media.duration ? this.props.start : 0;
    }
    if (this.props.mute) media.muted = true;
    this.updateSpeedLabel();
    if (this.props.autoplay) {
      const promise = media.play();
      if (promise && typeof promise.catch === "function") promise.catch(() => {});
    }
  }

  handlePlay() {
    const media = this.media;
    if (!media) return;
    const start = this.props.start != null ? this.props.start : 0;
    const atEnd = this.effectiveEnd != null && media.currentTime >= this.effectiveEnd - 0.05;
    const beforeStart = this.props.start != null && media.currentTime < this.props.start - 0.001;
    if (atEnd || beforeStart) {
      media.currentTime = start;
    }
    if (this.effectiveEnd != null) this.startTicker();
  }

  handleEnded() {
    const media = this.media;
    if (!media || !this.props.loop || this.effectiveEnd != null) return;
    media.currentTime = this.props.start != null ? this.props.start : 0;
    const promise = media.play();
    if (promise && typeof promise.catch === "function") promise.catch(() => {});
  }

  handleRateChange() {
    const media = this.media;
    if (!media) return;
    if (Math.abs(media.playbackRate - this.props.speed) > 0.0001) {
      this.props.speed = media.playbackRate;
    }
    this.updateSpeedLabel();
  }

  checkRange() {
    const media = this.media;
    if (!media || this.effectiveEnd == null) return;
    if (media.paused || media.seeking) return;
    if (media.currentTime < this.effectiveEnd) return;
    this.stopAtEnd();
  }

  stopAtEnd() {
    const media = this.media;
    if (!media) return;
    if (this.props.loop) {
      media.currentTime = this.props.start != null ? this.props.start : 0;
      return;
    }
    media.pause();
    if (media.currentTime !== this.effectiveEnd) {
      media.currentTime = this.effectiveEnd;
    }
  }

  clampToRange() {
    const media = this.media;
    if (!media || !this.plugin.settings.lockRange || !isFinite(media.duration)) return;
    const start = this.props.start;
    const end = this.effectiveEnd;
    const current = media.currentTime;
    let target = null;
    if (start != null && current < start - 0.001) {
      target = start;
    } else if (end != null && current > end + 0.001) {
      target = end;
    }
    if (target == null || Math.abs(current - target) < 0.001) return;
    media.currentTime = target;
  }

  jumpToStart() {
    const media = this.media;
    if (!media) return;
    media.currentTime = this.props.start != null ? this.props.start : 0;
  }

  seekTo(seconds) {
    const media = this.media;
    if (!media || !isFinite(seconds)) return;
    let target = seconds;
    if (this.plugin.settings.lockRange) {
      if (this.props.start != null && target < this.props.start) target = this.props.start;
      if (this.effectiveEnd != null && target > this.effectiveEnd) target = this.effectiveEnd;
    }
    media.currentTime = target;
  }

  flash() {
    if (!this.playerEl) return;
    this.playerEl.scrollIntoView({ behavior: "smooth", block: "center" });
    this.playerEl.classList.add("mc-flash");
    window.setTimeout(() => {
      if (this.playerEl) this.playerEl.classList.remove("mc-flash");
    }, 1200);
  }

  getLinktext() {
    try {
      const text = this.app.metadataCache.fileToLinktext(this.file, this.info.sourcePath || "", false);
      if (text) return text;
    } catch (error) {
      void error;
    }
    return this.file.path;
  }

  copyTimestamp() {
    const media = this.media;
    if (!media) return;
    const time = Math.max(0, media.currentTime);
    const seconds = trimNumber(Math.round(time * 1000) / 1000);
    const label = formatNPT(time);
    const text = `[[${this.getLinktext()}#t=${seconds}|${label}]]`;
    const done = () => new Notice("已复制时间戳：" + label);
    const failed = () => new Notice("复制失败，请检查剪贴板权限");
    try {
      const result = navigator.clipboard.writeText(text);
      if (result && typeof result.then === "function") {
        result.then(done, failed);
      } else {
        done();
      }
    } catch (error) {
      console.warn("Media Enhance: 复制时间戳失败", error);
      failed();
    }
  }

  startTicker() {
    if (this.rafId != null) return;
    const step = () => {
      this.rafId = null;
      const media = this.media;
      if (!media || media.paused || this.effectiveEnd == null) return;
      if (media.currentTime >= this.effectiveEnd) {
        if (this.props.loop) {
          media.currentTime = this.props.start != null ? this.props.start : 0;
        } else {
          if (media.currentTime !== this.effectiveEnd) media.currentTime = this.effectiveEnd;
          media.pause();
          return;
        }
      }
      this.rafId = requestAnimationFrame(step);
    };
    this.rafId = requestAnimationFrame(step);
  }

  stopTicker() {
    if (this.rafId != null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  setSpeed(speed) {
    this.props.speed = speed;
    if (this.media) this.media.playbackRate = speed;
    this.updateSpeedLabel();
    if (this.plugin.settings.rememberSpeed && Math.abs(this.plugin.settings.defaultSpeed - speed) > 0.0001) {
      this.plugin.settings.defaultSpeed = speed;
      this.plugin.saveSettings();
    }
  }

  applyProps(hash) {
    this.props = parseProps(this.plugin, hash);
    this.effectiveEnd = this.props.end;
    const media = this.media;
    if (media) {
      media.playbackRate = this.props.speed;
      media.loop = this.props.loop && this.props.start == null && this.props.end == null;
      if (this.props.start != null && media.currentTime < this.props.start) {
        media.currentTime = this.props.start;
      }
      if (this.effectiveEnd != null && media.currentTime > this.effectiveEnd) {
        media.currentTime = this.effectiveEnd;
      }
    }
    this.updateSpeedLabel();
  }

  updateSpeedLabel() {
    if (this.speedBtn) this.speedBtn.textContent = formatSpeed(this.props.speed);
  }

  showSpeedMenu(anchor) {
    const menu = new Menu();
    if (!SPEED_OPTIONS.some((option) => Math.abs(option - this.props.speed) < 0.001)) {
      menu.addItem((item) => item.setTitle(formatSpeed(this.props.speed)).setChecked(true));
      menu.addSeparator();
    }
    for (const option of SPEED_OPTIONS) {
      menu.addItem((item) =>
        item
          .setTitle(formatSpeed(option))
          .setChecked(Math.abs(this.props.speed - option) < 0.001)
          .onClick(() => this.setSpeed(option))
      );
    }
    menu.addSeparator();
    menu.addItem((item) =>
      item.setTitle("自定义…").setIcon("pencil").onClick(() => this.openCustomSpeed())
    );
    const rect = anchor.getBoundingClientRect();
    menu.showAtPosition({ x: rect.left, y: rect.bottom + 4 });
  }

  openCustomSpeed() {
    new SpeedPromptModal(this.app, this.props.speed, (value) => this.setSpeed(value)).open();
  }

  openEditor() {
    new ClipEditModal(this.app, this).open();
  }

  showContextMenu(event) {
    const menu = new Menu();
    menu.addItem((item) =>
      item.setTitle("复制当前时间戳").setIcon("copy").onClick(() => this.copyTimestamp())
    );
    menu.addSeparator();
    menu.addItem((item) =>
      item.setTitle("编辑片段参数").setIcon("pencil").onClick(() => this.openEditor())
    );
    let speedMenu = null;
    menu.addItem((item) => {
      item.setTitle("播放倍速").setIcon("gauge");
      if (typeof item.setSubmenu === "function") speedMenu = item.setSubmenu();
    });
    const target = speedMenu || menu;
    for (const option of SPEED_OPTIONS) {
      target.addItem((item) =>
        item
          .setTitle(formatSpeed(option))
          .setChecked(Math.abs(this.props.speed - option) < 0.001)
          .onClick(() => this.setSpeed(option))
      );
    }
    menu.addSeparator();
    menu.addItem((item) => item.setTitle("重置为 1×").onClick(() => this.setSpeed(1)));
    menu.showAtMouseEvent(event);
  }

  onunload() {
    if (this.plugin.players) this.plugin.players.delete(this);
    this.stopTicker();
    if (this.media) {
      try {
        this.media.pause();
      } catch (error) {
        void error;
      }
      this.media = null;
    }
    this.playerEl = null;
  }
}

class ClipModal extends Modal {
  constructor(plugin, file, seconds) {
    super(plugin.app);
    this.plugin = plugin;
    this.file = file;
    this.seconds = seconds;
    this.clip = null;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("mc-modal-player");
    contentEl.createEl("h4", { text: this.file.basename });
    const holder = contentEl.createDiv({ cls: "mc-modal-holder" });
    const activeFile = this.plugin.app.workspace.getActiveFile();
    const hash = "t=" + trimNumber(Math.round(this.seconds * 1000) / 1000);
    this.clip = new ClipEmbed(
      this.plugin,
      {
        app: this.plugin.app,
        containerEl: holder,
        sourcePath: activeFile ? activeFile.path : "",
        linktext: this.file.name,
      },
      this.file,
      hash,
      { modal: true }
    );
    this.clip.load();
  }

  onClose() {
    if (this.clip) {
      this.clip.unload();
      this.clip = null;
    }
    this.contentEl.empty();
  }
}

class SpeedPromptModal extends Modal {
  constructor(app, initial, onSubmit) {
    super(app);
    this.initial = initial;
    this.onSubmit = onSubmit;
  }

  onOpen() {
    this.contentEl.createEl("h3", { text: "自定义倍速" });
    const input = this.contentEl.createEl("input", { type: "number", cls: "mc-speed-input" });
    input.value = trimNumber(this.initial);
    input.step = "0.05";
    input.min = "0.25";
    input.max = "5";
    const buttons = this.contentEl.createDiv({ cls: "mc-modal-buttons" });
    buttons.createEl("button", { text: "取消" }).addEventListener("click", () => this.close());
    buttons
      .createEl("button", { text: "确定", cls: "mod-cta" })
      .addEventListener("click", () => {
        const value = Number(input.value);
        if (!isFinite(value) || value <= 0) {
          new Notice("请输入有效的倍速");
          return;
        }
        this.onSubmit(value);
        this.close();
      });
  }

  onClose() {
    this.contentEl.empty();
  }
}

class ClipEditModal extends Modal {
  constructor(app, embed) {
    super(app);
    this.embed = embed;
    this.plugin = embed.plugin;
    this.loopValue = embed.props.loop;
    this.autoplayValue = embed.props.autoplay;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("mc-edit-modal");
    contentEl.createEl("h3", { text: "编辑片段参数" });

    const startSetting = new Setting(contentEl)
      .setName("起始时间")
      .setDesc("秒 / MM:SS / HH:MM:SS，留空表示从 0 开始");
    startSetting.addText((text) => {
      text.setPlaceholder("00:10");
      text.setValue(this.embed.props.start != null ? formatNPT(this.embed.props.start) : "");
      this.startInput = text.inputEl;
    });
    startSetting.addExtraButton((button) => {
      button
        .setIcon("crosshair")
        .setTooltip("填入当前播放位置")
        .onClick(() => {
          this.startInput.value = formatNPT(this.embed.media ? this.embed.media.currentTime : 0);
        });
    });

    const endSetting = new Setting(contentEl)
      .setName("结束时间")
      .setDesc("留空或填写 e 表示播放到结尾");
    endSetting.addText((text) => {
      text.setPlaceholder("05:52 或 e");
      text.setValue(this.embed.props.end != null ? formatNPT(this.embed.props.end) : "e");
      this.endInput = text.inputEl;
    });
    endSetting.addExtraButton((button) => {
      button
        .setIcon("crosshair")
        .setTooltip("填入当前播放位置")
        .onClick(() => {
          this.endInput.value = formatNPT(this.embed.media ? this.embed.media.currentTime : 0);
        });
    });

    new Setting(contentEl).setName("播放倍速").addDropdown((dropdown) => {
      const options = SPEED_OPTIONS.slice();
      if (!options.some((option) => Math.abs(option - this.embed.props.speed) < 0.001)) {
        options.push(this.embed.props.speed);
      }
      options.sort((a, b) => a - b);
      for (const option of options) dropdown.addOption(String(option), formatSpeed(option));
      dropdown.setValue(String(this.embed.props.speed));
      this.speedSelect = dropdown;
    });

    new Setting(contentEl).setName("循环播放").addToggle((toggle) => {
      toggle.setValue(this.embed.props.loop);
      toggle.onChange((value) => {
        this.loopValue = value;
      });
    });

    new Setting(contentEl).setName("自动播放").addToggle((toggle) => {
      toggle.setValue(this.embed.props.autoplay);
      toggle.onChange((value) => {
        this.autoplayValue = value;
      });
    });

    const buttons = contentEl.createDiv({ cls: "mc-modal-buttons" });
    buttons.createEl("button", { text: "取消" }).addEventListener("click", () => this.close());
    buttons
      .createEl("button", { text: "保存", cls: "mod-cta" })
      .addEventListener("click", () => this.save());
  }

  async save() {
    const startText = this.startInput.value.trim();
    const endText = this.endInput.value.trim();
    let start = null;
    let end = null;
    if (startText) {
      start = parseNPT(startText);
      if (start == null) {
        new Notice("起始时间格式无效");
        return;
      }
    }
    if (endText && endText.toLowerCase() !== "e") {
      end = parseNPT(endText);
      if (end == null) {
        new Notice("结束时间格式无效");
        return;
      }
    }
    if (start != null && end != null && end <= start) {
      new Notice("结束时间必须大于起始时间");
      return;
    }
    const speed = Number(this.speedSelect.getValue());
    const props = {
      start,
      end,
      speed: isFinite(speed) && speed > 0 ? speed : this.plugin.settings.defaultSpeed,
      loop: this.loopValue,
      autoplay: this.autoplayValue,
      mute: this.embed.props.mute,
      extra: this.embed.props.extra,
    };
    const newHash = buildHash(this.plugin, props);
    const applied = await updateNoteLink(
      this.app,
      this.embed.info.sourcePath,
      this.embed.file,
      this.embed.props.raw,
      newHash
    );
    if (!applied) {
      new Notice("没有在笔记中找到对应的媒体链接，未能保存");
      return;
    }
    this.embed.applyProps(newHash);
    this.close();
  }

  onClose() {
    this.contentEl.empty();
  }
}

class ClipSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("默认播放倍速")
      .setDesc("链接中没有 speed= 时使用的倍速")
      .addDropdown((dropdown) => {
        for (const option of SPEED_OPTIONS) dropdown.addOption(String(option), formatSpeed(option));
        dropdown.setValue(String(this.plugin.settings.defaultSpeed));
        dropdown.onChange(async (value) => {
          this.plugin.settings.defaultSpeed = Number(value);
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("记住手动调整的倍速")
      .setDesc("用播放器调整倍速后，把它保存为默认倍速")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.rememberSpeed);
        toggle.onChange(async (value) => {
          this.plugin.settings.rememberSpeed = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("锁定片段起止范围")
      .setDesc("点击或拖动进度条时，不允许超出 #t= 设定的起始与结束时间")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.lockRange);
        toggle.onChange(async (value) => {
          this.plugin.settings.lockRange = value;
          await this.plugin.saveSettings();
        });
      });
  }
}

class MediaClipPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.players = new Set();
    this.clipModal = null;
    this.addSettingTab(new ClipSettingTab(this.app, this));
    this.registerMediaEmbeds();
    this.registerDomEvent(
      document,
      "click",
      (event) => this.handleTimestampClick(event),
      true
    );
    this.addCommand({
      id: "refresh-media-embeds",
      name: "刷新媒体嵌入显示",
      callback: () => {
        this.refreshEmbeds(true);
      },
    });
    this.app.workspace.onLayoutReady(() => {
      window.setTimeout(() => {
        this.refreshEmbeds(false);
      }, 600);
    });
  }

  findViewForElement(element) {
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (view && view.contentEl && view.contentEl.contains(element)) return view;
    }
    return null;
  }

  handleTimestampClick(event) {
    if (typeof event.button === "number" && event.button !== 0) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    const anchor = target.closest("a.internal-link");
    if (!anchor) return;
    if (anchor.closest(".popover, .hover-popover, .suggestion-container")) return;
    const href = anchor.getAttribute("data-href") || anchor.getAttribute("href") || "";
    const hashIndex = href.indexOf("#");
    if (hashIndex < 0) return;
    const linkPath = href.slice(0, hashIndex);
    const ext = mediaExtensionFromSrc(linkPath);
    if (!ext || MEDIA_EXTS.indexOf(ext) < 0) return;
    const hash = href.slice(hashIndex + 1);
    const match = /(?:^|&)t=([^&]*)/.exec(hash);
    if (!match) return;
    const start = parseNPT(match[1].split(",")[0]);
    if (start == null) return;
    const openGesture = event.ctrlKey || event.metaKey;
    const inEditor = !!target.closest(".cm-content");
    if (inEditor && !openGesture) return;
    event.preventDefault();
    event.stopPropagation();
    const owner = this.findViewForElement(anchor);
    const activeFile = this.app.workspace.getActiveFile();
    const sourcePath = owner && owner.file ? owner.file.path : activeFile ? activeFile.path : "";
    const file = this.app.metadataCache.getFirstLinkpathDest(linkPath, sourcePath);
    if (!file) return;
    this.locateTimestamp(file, start, owner);
  }

  locateTimestamp(file, seconds, preferredView) {
    let target = null;
    for (const player of this.players) {
      if (!player.media || !player.playerEl || !player.playerEl.isConnected) continue;
      if (player.file.path !== file.path) continue;
      if (
        preferredView &&
        preferredView.contentEl &&
        preferredView.contentEl.contains(player.playerEl)
      ) {
        target = player;
        break;
      }
      if (!target) target = player;
    }
    if (target) {
      target.seekTo(seconds);
      target.flash();
      return;
    }
    if (this.clipModal) this.clipModal.close();
    this.clipModal = new ClipModal(this, file, seconds);
    this.clipModal.open();
  }

  registerMediaEmbeds() {
    const registry = this.app.embedRegistry;
    if (!registry || typeof registry.registerExtensions !== "function") {
      console.warn("Media Clip: 无法访问 embedRegistry，嵌入播放增强不可用");
      return;
    }
    this.backups = new Map();
    if (registry.embedByExtension) {
      for (const ext of MEDIA_EXTS) {
        const creator = registry.embedByExtension[ext];
        if (creator) this.backups.set(ext, creator);
      }
    }
    try {
      registry.unregisterExtensions(MEDIA_EXTS);
    } catch (error) {
      console.warn("Media Clip: 注销原有嵌入处理器失败", error);
    }
    try {
      registry.registerExtensions(
        MEDIA_EXTS,
        (info, file, subpath) => new ClipEmbed(this, info, file, subpath)
      );
      this.embedRegistered = true;
    } catch (error) {
      console.error("Media Clip: 注册嵌入处理器失败", error);
      this.restoreMediaEmbeds();
    }
  }

  restoreMediaEmbeds() {
    const registry = this.app.embedRegistry;
    if (!registry) return;
    try {
      registry.unregisterExtensions(MEDIA_EXTS);
    } catch (error) {
      void error;
    }
    if (this.backups) {
      for (const entry of this.backups) {
        try {
          registry.registerExtension(entry[0], entry[1]);
        } catch (error) {
          void error;
        }
      }
    }
    this.embedRegistered = false;
  }

  hasMediaEmbed(view) {
    const root = view && view.contentEl;
    if (!root) return false;
    for (const element of root.querySelectorAll(".internal-embed")) {
      const ext = mediaExtensionFromSrc(element.getAttribute("src"));
      if (ext && MEDIA_EXTS.indexOf(ext) >= 0) return true;
    }
    return false;
  }

  needsRefresh(view) {
    const root = view && view.contentEl;
    if (!root) return false;
    for (const element of root.querySelectorAll(".internal-embed")) {
      const ext = mediaExtensionFromSrc(element.getAttribute("src"));
      if (!ext || MEDIA_EXTS.indexOf(ext) < 0) continue;
      if (!element.querySelector('.mc-player[data-mc="' + PLAYER_MARK + '"]')) return true;
    }
    return false;
  }

  async refreshEmbeds(force) {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
        const view = leaf.view;
        if (!view || !view.file || !this.hasMediaEmbed(view)) continue;
        if (!force && !this.needsRefresh(view)) continue;
        const mode =
          typeof view.getMode === "function"
            ? view.getMode()
            : typeof view.getState === "function" && view.getState()
              ? view.getState().mode
              : "source";
        if (mode !== "source" && view.previewMode && typeof view.previewMode.rerender === "function") {
          view.previewMode.rerender(true);
          continue;
        }
        const state = leaf.getViewState();
        await leaf.setViewState({ type: "empty" });
        await leaf.setViewState(state);
      }
    } finally {
      this.refreshing = false;
    }
  }

  markPlayersStale() {
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (!view || !view.contentEl) continue;
      for (const player of view.contentEl.querySelectorAll(".mc-player[data-mc]")) {
        player.removeAttribute("data-mc");
      }
    }
  }

  onunload() {
    if (this.clipModal) {
      this.clipModal.close();
      this.clipModal = null;
    }
    if (this.embedRegistered) this.restoreMediaEmbeds();
    this.markPlayersStale();
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, (await this.loadData()) || {});
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

module.exports = MediaClipPlugin;
module.exports.default = MediaClipPlugin;
