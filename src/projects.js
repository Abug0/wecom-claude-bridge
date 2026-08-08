// 项目注册表（JSON 持久化，原子写）
// 结构: { projects: { <projectKey>: { name, cwd, currentTask, tasks: {...} } } }
const fs = require("fs");
const path = require("path");

/**
 * 复刻 Claude 的 cwd 编码：非字母数字字符替换为 '-'
 * @param {string} cwd 如 /path\projects\PROJECT
 * @returns {string} 如 encoded-project-key
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

  /** 获取项目下的任务列表（按最近活跃排序） */
  listTasks(projectKey) {
    const p = this.data.projects[projectKey];
    if (!p) return [];
    return Object.entries(p.tasks)
      .map(([name, t]) => ({ name, ...t }))
      .sort((a, b) =>
        String(b.lastActiveAt || "").localeCompare(String(a.lastActiveAt || ""))
      );
  }

  getTask(projectKey, taskName) {
    const p = this.data.projects[projectKey];
    return p && p.tasks[taskName] ? p.tasks[taskName] : null;
  }

  /** 按名称或编号（1基，按最近活跃排序）查找任务 */
  findTask(projectKey, selector) {
    const tasks = this.listTasks(projectKey);
    // 名称精确匹配
    const byName = tasks.find((t) => t.name === selector);
    if (byName) return byName;
    // 编号
    if (/^\d+$/.test(selector)) {
      const idx = parseInt(selector, 10) - 1;
      return tasks[idx] || null;
    }
    return null;
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
