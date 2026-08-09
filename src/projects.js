// 项目注册表（JSON 持久化，原子写）
// 结构: { projects: { <projectKey>: { name, cwd, currentTask, tasks: {...} } } }
const fs = require("fs");
const path = require("path");

/**
 * 复刻 Claude 的 cwd 编码：非字母数字字符替换为 '-'
 * @param {string} cwd 如 /path/to/project
 * @returns {string} 如 path-to-project
 */
function encodeCwd(cwd) {
  return cwd
    .replace(/\\/g, "/")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "-");
}

class ProjectRegistry {
  constructor(file) {
    this.file = file;
    this.data = this._load();
  }

  _load() {
    if (this.file && fs.existsSync(this.file)) {
      try {
        return JSON.parse(fs.readFileSync(this.file, "utf8"));
      } catch (e) {
        // 损坏则备份后重建
        try {
          fs.copyFileSync(this.file, this.file + ".bak");
        } catch {}
      }
    }
    return { projects: {} };
  }

  _save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), "utf8");
    fs.renameSync(tmp, this.file); // 原子替换
  }

  /** 获取或创建项目，返回 { key, cwd, name } */
  getProject(selector) {
    // selector 可以是路径或项目名
    const byName = Object.entries(this.data.projects).find(
      ([, p]) => p.name === selector
    );
    if (byName) return byName[1];

    // 按路径找
    const norm = selector.replace(/\\/g, "/");
    const byCwd = Object.entries(this.data.projects).find(
      ([, p]) => p.cwd.replace(/\\/g, "/").toLowerCase() === norm.toLowerCase()
    );
    if (byCwd) return byCwd[1];

    return null;
  }

  /** 添加新项目 */
  addProject(cwd, name) {
    const key = encodeCwd(cwd);
    if (!this.data.projects[key]) {
      this.data.projects[key] = {
        name: name || key,
        cwd,
        currentTask: null,
        tasks: {},
      };
      this._save();
    }
    return this.data.projects[key];
  }

  listProjects() {
    return Object.values(this.data.projects);
  }

  /** 获取项目下的任务列表（pinned 优先，组内按最近活跃排序） */
  listTasks(projectKey) {
    const p = this.data.projects[projectKey];
    if (!p) return [];
    return Object.entries(p.tasks)
      .map(([name, t]) => ({ name, ...t }))
      .sort((a, b) => {
        const pa = a.pinned ? 1 : 0;
        const pb = b.pinned ? 1 : 0;
        if (pa !== pb) return pb - pa;
        return String(b.lastActiveAt || "").localeCompare(String(a.lastActiveAt || ""));
      });
  }

  getTask(projectKey, taskName) {
    const p = this.data.projects[projectKey];
    return p && p.tasks[taskName] ? p.tasks[taskName] : null;
  }

  /**
   * 按名称/别名/编号/模糊子串查找任务
   * 优先级：名称精确 → 别名精确 → 纯数字编号 → 大小写不敏感子串（name/slug/alias）
   * @param {string} projectKey
   * @param {string} selector
   * @returns {object|null}
   */
  findTask(projectKey, selector) {
    const tasks = this.listTasks(projectKey);
    const key = String(selector || "").trim();
    // 1) 名称精确匹配
    const byName = tasks.find((t) => t.name === key);
    if (byName) return byName;
    // 2) 别名精确匹配
    const byAlias = tasks.find((t) => t.alias && t.alias === key);
    if (byAlias) return byAlias;
    // 3) 纯数字 → 编号（基于 listTasks 排序，含 pinned 优先）
    if (/^\d+$/.test(key)) {
      const idx = parseInt(key, 10) - 1;
      return tasks[idx] || null;
    }
    // 4) 大小写不敏感子串（name/slug/alias）
    const lower = key.toLowerCase();
    return (
      tasks.find(
        (t) =>
          t.name.toLowerCase().includes(lower) ||
          (t.slug && t.slug.toLowerCase().includes(lower)) ||
          (t.alias && t.alias.toLowerCase().includes(lower))
      ) || null
    );
  }

  getCurrentTask(projectKey) {
    const p = this.data.projects[projectKey];
    if (!p || !p.currentTask) return null;
    return p.tasks[p.currentTask] ? { name: p.currentTask, ...p.tasks[p.currentTask] } : null;
  }

  setCurrentTask(projectKey, taskName) {
    const p = this.data.projects[projectKey];
    if (!p || !p.tasks[taskName]) return false;
    p.currentTask = taskName;
    this._save();
    return true;
  }

  addTask(projectKey, taskName, task) {
    const p = this.data.projects[projectKey];
    if (!p) return false;
    p.tasks[taskName] = { ...task, lastActiveAt: new Date().toISOString() };
    p.currentTask = taskName;
    this._save();
    return true;
  }

  touchTask(projectKey, taskName) {
    const p = this.data.projects[projectKey];
    if (p && p.tasks[taskName]) {
      p.tasks[taskName].lastActiveAt = new Date().toISOString();
      this._save();
    }
  }

  /**
   * 置顶/取消置顶任务（pinned 翻转）
   * @param {string} projectKey
   * @param {string} selector 名称/别名/编号/子串
   * @returns {boolean|null} 新 pinned 值；未找到返回 null
   */
  togglePin(projectKey, selector) {
    const task = this.findTask(projectKey, selector);
    if (!task) return null;
    const p = this.data.projects[projectKey];
    const t = p.tasks[task.name];
    t.pinned = !t.pinned;
    this._save();
    return !!t.pinned;
  }

  /**
   * 设置/清除任务别名（空串或缺省则删除）
   * @param {string} projectKey
   * @param {string} selector 名称/别名/编号/子串
   * @param {string} alias 新别名；空串删除
   * @returns {boolean} 是否成功
   */
  setAlias(projectKey, selector, alias) {
    const task = this.findTask(projectKey, selector);
    if (!task) return false;
    const p = this.data.projects[projectKey];
    const t = p.tasks[task.name];
    if (alias) t.alias = alias;
    else delete t.alias;
    this._save();
    return true;
  }

  removeTask(projectKey, taskName) {
    const p = this.data.projects[projectKey];
    if (!p || !p.tasks[taskName]) return false;
    delete p.tasks[taskName];
    if (p.currentTask === taskName) p.currentTask = null;
    this._save();
    return true;
  }

  removeProject(projectKey) {
    if (this.data.projects[projectKey]) {
      delete this.data.projects[projectKey];
      this._save();
      return true;
    }
    return false;
  }
}

module.exports = { ProjectRegistry, encodeCwd };
