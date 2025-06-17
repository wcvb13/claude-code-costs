#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const os = require('os');
const { exec } = require('child_process');

// Claude API Pricing (per million tokens)
const CLAUDE_PRICING = {
  // Claude Opus 4
  'claude-opus-4-20250514': {
    input: 15.0,
    output: 75.0,
    cache_write: 18.75,
    cache_read: 1.5
  },
  // Claude Sonnet 4
  'claude-sonnet-4-20250514': {
    input: 3.0,
    output: 15.0,
    cache_write: 3.75,
    cache_read: 0.3
  },
  // Claude Sonnet 3.7
  'claude-3-7-sonnet-20250219': {
    input: 3.0,
    output: 15.0,
    cache_write: 3.75,
    cache_read: 0.3
  },
  'claude-3-7-sonnet-latest': {
    input: 3.0,
    output: 15.0,
    cache_write: 3.75,
    cache_read: 0.3
  },
  // Claude Sonnet 3.5
  'claude-3-5-sonnet-20241022': {
    input: 3.0,
    output: 15.0,
    cache_write: 3.75,
    cache_read: 0.3
  },
  'claude-3-5-sonnet-20240620': {
    input: 3.0,
    output: 15.0,
    cache_write: 3.75,
    cache_read: 0.3
  },
  'claude-3-5-sonnet-latest': {
    input: 3.0,
    output: 15.0,
    cache_write: 3.75,
    cache_read: 0.3
  },
  // Claude Haiku 3.5
  'claude-3-5-haiku-20241022': {
    input: 0.8,
    output: 4.0,
    cache_write: 1.0,
    cache_read: 0.08
  },
  'claude-3-5-haiku-latest': {
    input: 0.8,
    output: 4.0,
    cache_write: 1.0,
    cache_read: 0.08
  },
  // Claude Opus 3
  'claude-3-opus-20240229': {
    input: 15.0,
    output: 75.0,
    cache_write: 18.75,
    cache_read: 1.5
  },
  'claude-3-opus-latest': {
    input: 15.0,
    output: 75.0,
    cache_write: 18.75,
    cache_read: 1.5
  },
  // Claude Sonnet 3
  'claude-3-sonnet-20240229': {
    input: 3.0,
    output: 15.0,
    cache_write: 3.75,
    cache_read: 0.3
  },
  // Claude Haiku 3
  'claude-3-haiku-20240307': {
    input: 0.25,
    output: 1.25,
    cache_write: 0.3,
    cache_read: 0.03
  },
  // Default pricing (use Sonnet 3.5 as default)
  default: {
    input: 3.0,
    output: 15.0,
    cache_write: 3.75,
    cache_read: 0.3
  }
};

function calculateCost(usage, model) {
  if (!usage) return 0;

  // Get pricing for the model, fallback to default
  const pricing = CLAUDE_PRICING[model] || CLAUDE_PRICING['default'];

  // Calculate costs for each token type (price per million tokens)
  const inputCost = ((usage.input_tokens || 0) * pricing.input) / 1000000;
  const outputCost = ((usage.output_tokens || 0) * pricing.output) / 1000000;
  const cacheWriteCost = ((usage.cache_creation_input_tokens || 0) * pricing.cache_write) / 1000000;
  const cacheReadCost = ((usage.cache_read_input_tokens || 0) * pricing.cache_read) / 1000000;

  return inputCost + outputCost + cacheWriteCost + cacheReadCost;
}

async function parseJSONLFile(filePath) {
  const fileStream = fs.createReadStream(filePath);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity
  });

  let totalCost = 0;
  let messageCount = 0;
  let conversationName = '';
  let conversationTitle = '';
  let startTime = null;
  let endTime = null;
  let summary = '';
  let firstUserMessage = '';

  for await (const line of rl) {
    try {
      const message = JSON.parse(line);

      // Extract conversation metadata
      if (message.type === 'summary') {
        if (message.summary) {
          summary = message.summary;
        }
        if (message.metadata) {
          conversationName = message.metadata.workingDirectory || message.metadata.cwd || 'Unknown';
          if (message.metadata.thread_summary) {
            conversationTitle = message.metadata.thread_summary;
          }
          if (message.metadata.summary) {
            conversationTitle = message.metadata.summary;
          }
        }
      }

      // Capture first user message as fallback title
      if (message.type === 'user' && !firstUserMessage && message.text) {
        firstUserMessage = message.text.substring(0, 100);
      }

      // Extract cost data from assistant messages
      if (message.type === 'assistant' && message.message) {
        const usage = message.message.usage;
        const model = message.message.model;
        if (usage && model) {
          const cost = calculateCost(usage, model);
          totalCost += cost;
          messageCount++;
        }
      }

      // Track conversation time range - FIXED: use timestamp field
      if (message.timestamp) {
        const timestamp = new Date(message.timestamp);
        if (!startTime || timestamp < startTime) startTime = timestamp;
        if (!endTime || timestamp > endTime) endTime = timestamp;
      }
    } catch (e) {
      // Silent error handling
    }
  }

  // Determine best title
  if (!conversationTitle) {
    conversationTitle = summary || firstUserMessage || 'Untitled conversation';
  }

  return {
    conversationId: path.basename(filePath, '.jsonl'),
    conversationName,
    conversationTitle: conversationTitle.replace(/\n/g, ' ').substring(0, 100),
    totalCost,
    messageCount,
    startTime,
    endTime,
    duration: endTime && startTime ? (endTime - startTime) / 1000 / 60 : 0 // in minutes
  };
}

async function analyzeAllConversations() {
  const claudeProjectsDir = path.join(process.env.HOME, '.claude', 'projects');

  if (!fs.existsSync(claudeProjectsDir)) {
    console.error('Claude projects directory not found:', claudeProjectsDir);
    return [];
  }

  const conversations = [];

  // Get all project directories
  const projectDirs = fs
    .readdirSync(claudeProjectsDir)
    .filter(dir => fs.statSync(path.join(claudeProjectsDir, dir)).isDirectory());
  
  console.log(`Found ${projectDirs.length} project directories`);

  let processedCount = 0;
  const totalFiles = projectDirs.reduce((acc, dir) => {
    const projectPath = path.join(claudeProjectsDir, dir);
    try {
      const files = fs.readdirSync(projectPath).filter(f => f.endsWith('.jsonl'));
      return acc + files.length;
    } catch (e) {
      console.error(`Error reading project directory ${projectPath}:`, e.message);
      return acc;
    }
  }, 0);
  
  console.log(`Total JSONL files to process: ${totalFiles}`);

  for (const projectDir of projectDirs) {
    const projectPath = path.join(claudeProjectsDir, projectDir);
    const jsonlFiles = fs.readdirSync(projectPath).filter(file => file.endsWith('.jsonl'));

    for (const jsonlFile of jsonlFiles) {
      const filePath = path.join(projectPath, jsonlFile);
      processedCount++;
      process.stdout.write(`\rProcessing: ${processedCount}/${totalFiles} files...`);

      try {
        const conversation = await parseJSONLFile(filePath);
        conversation.projectName = projectDir;
        
        // Only add conversations that have messages
        if (conversation.messageCount > 0) {
          conversations.push(conversation);
        }
      } catch (e) {
        console.error(`\nError processing file ${jsonlFile}:`, e.message);
      }
    }
  }

  console.log('\n'); // New line after progress
  return conversations;
}

function aggregateDailyCosts(conversations) {
  const dailyCosts = {};

  conversations.forEach(conv => {
    if (conv.totalCost > 0 && conv.startTime) {
      const dateKey = conv.startTime.toISOString().split('T')[0];
      if (!dailyCosts[dateKey]) {
        dailyCosts[dateKey] = {
          date: dateKey,
          totalCost: 0,
          conversationCount: 0,
          conversations: []
        };
      }
      dailyCosts[dateKey].totalCost += conv.totalCost;
      dailyCosts[dateKey].conversationCount += 1;
      dailyCosts[dateKey].conversations.push(conv);
    }
  });

  // Convert to array and sort by date
  return Object.values(dailyCosts).sort((a, b) => a.date.localeCompare(b.date));
}

function getLast30Days() {
  const days = [];
  const today = new Date();

  for (let i = 29; i >= 0; i--) {
    const date = new Date(today);
    date.setDate(date.getDate() - i);
    days.push(date.toISOString().split('T')[0]);
  }

  return days;
}

function createHTMLReport(conversations) {
  const conversationsWithCosts = conversations
    .filter(c => c.totalCost > 0)
    .sort((a, b) => b.totalCost - a.totalCost);

  const totalCost = conversationsWithCosts.reduce((sum, c) => sum + c.totalCost, 0);

  // Get unique projects for filter
  const uniqueProjects = [...new Set(conversationsWithCosts.map(c => c.projectName))];

  // Get daily data
  const dailyData = aggregateDailyCosts(conversations);
  const last30Days = getLast30Days();

  // Fill in missing days with zero cost
  const dailyCostMap = {};
  dailyData.forEach(d => {
    dailyCostMap[d.date] = {
      cost: d.totalCost,
      conversations: d.conversations
    };
  });

  const last30DaysData = last30Days.map(date => ({
    date,
    cost: dailyCostMap[date]?.cost || 0,
    conversations: dailyCostMap[date]?.conversations || []
  }));

  // Prepare data for top conversations chart
  const chartData = conversationsWithCosts.slice(0, 20).map(c => ({
    label: c.conversationTitle || c.conversationName.split('/').pop() || 'Unknown',
    cost: c.totalCost,
    date: c.startTime ? c.startTime.toLocaleDateString() : 'Unknown',
    projectName: c.projectName
  }));

  const html = `<!DOCTYPE html>
<html data-theme="claude" data-mode="dark">
<head>
    <title>Claude Code Conversation Cost Analysis</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/date-fns@2.29.3/index.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/chartjs-adapter-date-fns@3.0.0/dist/chartjs-adapter-date-fns.bundle.min.js"></script>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <style>
        /* Claude Theme CSS Variables - Enhanced to match claude.ai */
        [data-theme=claude][data-mode=light] {
            --accent-brand: 15 63.1% 59.6%; --accent-main-100: 15 55.6% 52.4%; --accent-main-200: 15 63.1% 59.6%;
            --accent-pro-100: 251 40% 45.1%; --accent-pro-200: 251 61% 72.2%; --accent-secondary-100: 210 70.9% 51.6%;
            --bg-000: 0 0% 100%; --bg-100: 48 33.3% 97.1%; --bg-200: 53 28.6% 94.5%; --bg-300: 48 25% 92.2%; --bg-400: 50 20.7% 88.6%;
            --border-100: 48 11.5% 88.2%; --danger-100: 0 58.6% 34.1%; --oncolor-100: 0 0% 100%;
            --text-000: 60 2.6% 7.6%; --text-100: 60 2.6% 7.6%; --text-200: 60 2.5% 23.3%; --text-300: 60 2.5% 23.3%; --text-400: 51 3.1% 43.7%;
            --accent-success: 130 50% 50%;
        }
        [data-theme=claude][data-mode=dark] {
            --accent-brand: 15 63.1% 59.6%; --accent-main-100: 15 63.1% 59.6%; --accent-main-200: 15 63.1% 59.6%;
            --accent-pro-000: 251 84.6% 74.5%; --accent-pro-100: 251 40.2% 54.1%; --accent-pro-200: 251 40% 45.1%; --accent-pro-900: 250 25.3% 19.4%;
            --accent-secondary-100: 210 70.9% 51.6%; --bg-000: 60 2.1% 18.4%; --bg-100: 60 2.7% 14.5%; --bg-200: 30 3.3% 11.8%; --bg-300: 60 2.6% 7.6%;
            --bg-400: 60 3.4% 5.7%; --border-100: 51 16.5% 84.5%; --danger-100: 0 58.6% 34.1%; --oncolor-100: 0 0% 100%;
            --text-000: 48 33.3% 97.1%; --text-100: 48 33.3% 97.1%; --text-200: 50 9% 73.7%; --text-300: 50 9% 73.7%; --text-400: 48 4.8% 59.2%;
            --accent-success: 130 50% 60%;
        }
        
        body {
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            margin: 0;
            background-color: hsl(var(--bg-100));
            color: hsl(var(--text-100));
        }
        .container {
            max-width: 1400px;
            margin: 0 auto;
            background-color: hsl(var(--bg-000));
            padding: 2rem;
            box-shadow: 0 1px 3px hsla(var(--text-000), 0.04), 0 4px 12px hsla(var(--text-000), 0.04);
        }
        h1 {
            color: hsl(var(--text-000));
            text-align: center;
            font-size: 2rem;
            margin-bottom: 2rem;
        }
        h2 {
            color: hsl(var(--text-000));
            font-size: 1.5rem;
            margin: 2rem 0 1rem 0;
        }
        .header {
            background-color: hsla(var(--bg-000), 0.95);
            border-bottom: 1px solid hsl(var(--bg-300));
            padding: 1.5rem 2rem;
            backdrop-filter: blur(12px);
            -webkit-backdrop-filter: blur(12px);
            margin: -2rem -2rem 2rem -2rem;
            display: flex;
            align-items: center;
            justify-content: space-between;
        }
        .header-title {
            display: flex;
            align-items: center;
            gap: 1rem;
        }
        .header-title i {
            color: hsl(var(--accent-brand));
            font-size: 2rem;
        }
        .theme-toggle {
            background-color: hsl(var(--bg-200));
            color: hsl(var(--text-200));
            border: none;
            padding: 0.5rem 1rem;
            border-radius: 0.5rem;
            cursor: pointer;
            transition: all 0.2s;
            display: flex;
            align-items: center;
            gap: 0.5rem;
        }
        .theme-toggle:hover {
            background-color: hsl(var(--bg-300));
        }
        .summary {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
            gap: 1rem;
            margin: 2rem 0;
        }
        .summary-item {
            padding: 1.5rem;
            background-color: hsl(var(--bg-200));
            border-radius: 12px;
            border: 1px solid hsl(var(--bg-300));
            text-align: center;
            transition: all 0.2s;
        }
        .summary-item:hover {
            transform: translateY(-2px);
            box-shadow: 0 2px 8px hsla(var(--text-000), 0.08);
        }
        .summary-item .label {
            color: hsl(var(--text-300));
            font-size: 0.875rem;
            margin-bottom: 0.5rem;
        }
        .summary-value {
            font-size: 2rem;
            font-weight: bold;
            color: hsl(var(--accent-pro-100));
        }
        .chart-container {
            position: relative;
            height: 400px;
            margin: 2rem 0;
            padding: 1.5rem;
            background-color: hsl(var(--bg-200));
            border-radius: 12px;
            border: 1px solid hsl(var(--bg-300));
        }
        .daily-chart-container {
            position: relative;
            height: 300px;
            margin: 2rem 0;
            padding: 1.5rem;
            background-color: hsl(var(--bg-200));
            border-radius: 12px;
            border: 1px solid hsl(var(--bg-300));
        }
        .filter-container {
            margin: 2rem 0;
            padding: 1.5rem;
            background-color: hsl(var(--bg-200));
            border-radius: 12px;
            border: 1px solid hsl(var(--bg-300));
        }
        .filter-container label {
            margin-right: 0.75rem;
            font-weight: 600;
            color: hsl(var(--text-200));
        }
        .filter-container select {
            padding: 0.5rem 1rem;
            border-radius: 0.5rem;
            border: 1px solid hsl(var(--bg-400));
            background-color: hsl(var(--bg-300));
            color: hsl(var(--text-100));
            margin-right: 1.5rem;
            cursor: pointer;
            transition: all 0.2s;
        }
        .filter-container select:hover {
            border-color: hsl(var(--accent-pro-100));
        }
        table {
            width: 100%;
            border-collapse: collapse;
            margin-top: 2rem;
            background-color: hsl(var(--bg-200));
            border-radius: 12px;
            overflow: hidden;
            border: 1px solid hsl(var(--bg-300));
        }
        th {
            background-color: hsl(var(--bg-300));
            font-weight: 600;
            color: hsl(var(--text-100));
            text-align: left;
            padding: 1rem;
            border-bottom: 1px solid hsl(var(--bg-400));
        }
        td {
            padding: 1rem;
            border-bottom: 1px solid hsl(var(--bg-300));
            color: hsl(var(--text-200));
        }
        tr {
            transition: background-color 0.2s;
        }
        tr:hover {
            background-color: hsla(var(--accent-pro-100), 0.05);
        }
        tr:last-child td {
            border-bottom: none;
        }
        .cost {
            font-weight: 600;
            color: hsl(var(--accent-success));
        }
        .conversation-title {
            max-width: 400px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            color: hsl(var(--text-100));
        }
        .project-name {
            color: hsl(var(--accent-pro-100));
            font-family: 'Fira Code', monospace;
            font-size: 0.875rem;
        }
        
        /* Privacy mode styles */
        .privacy-toggle {
            background-color: hsl(var(--bg-200));
            color: hsl(var(--text-200));
            border: none;
            padding: 0.5rem 1rem;
            border-radius: 0.5rem;
            cursor: pointer;
            transition: all 0.2s;
            display: flex;
            align-items: center;
            gap: 0.5rem;
        }
        .privacy-toggle:hover {
            background-color: hsl(var(--bg-300));
        }
        .privacy-toggle.active {
            background-color: hsl(var(--accent-brand));
            color: white;
        }
        
        .privacy-blur {
            filter: blur(4px);
            transition: filter 0.3s ease;
            user-select: none;
            -webkit-user-select: none;
        }
        .privacy-blur:hover {
            filter: blur(2px);
        }
        
        /* Scrollbar styling */
        ::-webkit-scrollbar {
            width: 8px;
            height: 8px;
        }
        ::-webkit-scrollbar-track {
            background: hsl(var(--bg-200));
        }
        ::-webkit-scrollbar-thumb {
            background-color: hsl(var(--bg-400));
            border-radius: 20px;
        }
        ::-webkit-scrollbar-thumb:hover {
            background-color: hsl(var(--accent-pro-100));
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div class="header-title">
                <i class="fas fa-chart-line"></i>
                <h1 style="margin: 0;">Claude Code 对话花费分析</h1>
            </div>
            <div style="display: flex; gap: 0.75rem;">
                <button class="privacy-toggle" onclick="togglePrivacy()" title="开启/关闭隐私模式">
                    <i class="fas fa-eye" id="privacy-icon"></i>
                    <span id="privacy-text">隐私模式</span>
                </button>
                <button class="theme-toggle" onclick="toggleTheme()">
                    <i class="fas fa-sun" id="theme-icon"></i>
                    <span>Light Mode</span>
                </button>
            </div>
        </div>
        
        <div class="summary">
            <div class="summary-item">
                <div class="label">总花费</div>
                <div class="summary-value">$${totalCost.toFixed(4)}</div>
            </div>
            <div class="summary-item">
                <div class="label">对话数量</div>
                <div class="summary-value">${conversationsWithCosts.length}</div>
            </div>
            <div class="summary-item">
                <div class="label">平均花费</div>
                <div class="summary-value">$${(totalCost / conversationsWithCosts.length).toFixed(
                  4
                )}</div>
            </div>
        </div>

        <div class="filter-container">
            <label for="projectFilter">按项目筛选:</label>
            <select id="projectFilter">
                <option value="all">所有项目</option>
                ${uniqueProjects
                  .map((p, index) => `<option value="${p}" class="project-option" data-original="${p.replace(/-Users-haleclipse-WorkSpace-/, '')}" data-generic="项目 #${index + 1}">${p.replace(/-Users-haleclipse-WorkSpace-/, '')}</option>`)
                  .join('')}
            </select>
        </div>

        <h2><i class="fas fa-calendar-alt" style="color: hsl(var(--accent-brand)); margin-right: 0.5rem;"></i>每日花费统计 (最近30天)</h2>
        <div class="daily-chart-container">
            <canvas id="dailyChart"></canvas>
        </div>

        <h2><i class="fas fa-trophy" style="color: hsl(var(--accent-brand)); margin-right: 0.5rem;"></i>花费最高的20个对话</h2>
        <div class="chart-container">
            <canvas id="costChart"></canvas>
        </div>

        <table id="conversationTable">
            <thead>
                <tr>
                    <th><i class="fas fa-comments" style="margin-right: 0.5rem;"></i>对话标题</th>
                    <th><i class="fas fa-folder" style="margin-right: 0.5rem;"></i>项目</th>
                    <th><i class="fas fa-dollar-sign" style="margin-right: 0.5rem;"></i>花费</th>
                    <th><i class="fas fa-envelope" style="margin-right: 0.5rem;"></i>消息数</th>
                    <th><i class="fas fa-clock" style="margin-right: 0.5rem;"></i>时长</th>
                    <th><i class="fas fa-calendar" style="margin-right: 0.5rem;"></i>日期</th>
                </tr>
            </thead>
            <tbody>
                ${conversationsWithCosts
                  .slice(0, 20)
                  .map(
                    conv => `
                    <tr data-project="${conv.projectName}">
                        <td class="conversation-title privacy-sensitive" title="${
                          conv.conversationTitle
                        }">${conv.conversationTitle}</td>
                        <td class="project-name privacy-sensitive">${(conv.conversationName.split('/').pop() || conv.projectName).replace(/-Users-haleclipse-WorkSpace-/, '')}</td>
                        <td class="cost">$${conv.totalCost.toFixed(6)}</td>
                        <td style="color: hsl(var(--text-200));">${conv.messageCount}</td>
                        <td style="color: hsl(var(--text-200));">${conv.duration.toFixed(1)} 分钟</td>
                        <td style="color: hsl(var(--text-300)); font-family: 'Fira Code', monospace; font-size: 0.875rem;">${conv.startTime ? conv.startTime.toLocaleDateString() : 'Unknown'}</td>
                    </tr>
                `
                  )
                  .join('')}
            </tbody>
        </table>
    </div>

    <script>
        // Store all conversation data for filtering
        const allConversations = ${JSON.stringify(conversationsWithCosts)};
        const dailyDataByProject = ${JSON.stringify(last30DaysData)};
        
        // Theme management
        let currentTheme = 'dark';
        let privacyMode = false;
        
        // Chart colors based on theme
        const getChartColors = () => {
            if (currentTheme === 'dark') {
                return {
                    primary: 'hsl(251, 40.2%, 54.1%)',
                    primaryAlpha: 'hsla(251, 40.2%, 54.1%, 0.2)',
                    secondary: 'hsl(15, 63.1%, 59.6%)',
                    secondaryAlpha: 'hsla(15, 63.1%, 59.6%, 0.2)',
                    text: 'hsl(48, 33.3%, 97.1%)',
                    grid: 'hsla(48, 33.3%, 97.1%, 0.1)'
                };
            } else {
                return {
                    primary: 'hsl(251, 40%, 45.1%)',
                    primaryAlpha: 'hsla(251, 40%, 45.1%, 0.2)',
                    secondary: 'hsl(15, 55.6%, 52.4%)',
                    secondaryAlpha: 'hsla(15, 55.6%, 52.4%, 0.2)',
                    text: 'hsl(60, 2.6%, 7.6%)',
                    grid: 'hsla(60, 2.6%, 7.6%, 0.1)'
                };
            }
        };

        // Daily cost chart
        const dailyCtx = document.getElementById('dailyChart').getContext('2d');
        const dailyChart = new Chart(dailyCtx, {
            type: 'line',
            data: {
                labels: ${JSON.stringify(last30DaysData.map(d => d.date))},
                datasets: [{
                    label: '每日花费 (USD)',
                    data: ${JSON.stringify(last30DaysData.map(d => d.cost))},
                    backgroundColor: getChartColors().primaryAlpha,
                    borderColor: getChartColors().primary,
                    borderWidth: 2,
                    fill: true,
                    tension: 0.2,
                    pointBackgroundColor: getChartColors().primary,
                    pointBorderColor: getChartColors().primary,
                    pointBorderWidth: 2,
                    pointRadius: 4
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: {
                    mode: 'index',
                    intersect: false,
                },
                scales: {
                    x: {
                        type: 'time',
                        time: {
                            unit: 'day',
                            displayFormats: {
                                day: 'MMM d'
                            }
                        },
                        ticks: {
                            color: getChartColors().text
                        },
                        grid: {
                            color: getChartColors().grid
                        }
                    },
                    y: {
                        beginAtZero: true,
                        ticks: {
                            color: getChartColors().text,
                            callback: function(value) {
                                return '$' + value.toFixed(2);
                            }
                        },
                        grid: {
                            color: getChartColors().grid
                        }
                    }
                },
                plugins: {
                    legend: {
                        labels: {
                            color: getChartColors().text
                        }
                    },
                    tooltip: {
                        backgroundColor: 'hsla(var(--bg-300), 0.9)',
                        titleColor: 'hsl(var(--text-100))',
                        bodyColor: 'hsl(var(--text-200))',
                        borderColor: 'hsl(var(--bg-400))',
                        borderWidth: 1,
                        callbacks: {
                            label: function(context) {
                                const dayData = dailyDataByProject[context.dataIndex];
                                const lines = ['花费: $' + context.parsed.y.toFixed(4)];
                                if (dayData && dayData.conversations.length > 0) {
                                    lines.push('对话数: ' + dayData.conversations.length);
                                    lines.push('---');
                                    dayData.conversations.slice(0, 3).forEach(conv => {
                                        lines.push(conv.conversationTitle.substring(0, 40) + '...: $' + conv.totalCost.toFixed(2));
                                    });
                                    if (dayData.conversations.length > 3) {
                                        lines.push('... 还有 ' + (dayData.conversations.length - 3) + ' 个');
                                    }
                                }
                                return lines;
                            }
                        }
                    }
                }
            }
        });

        // Top conversations chart
        const ctx = document.getElementById('costChart').getContext('2d');
        const conversationChart = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: ${JSON.stringify(
                  chartData.map(c => c.label.substring(0, 50) + (c.label.length > 50 ? '...' : ''))
                )},
                datasets: [{
                    label: '花费 (USD)',
                    data: ${JSON.stringify(chartData.map(c => c.cost))},
                    backgroundColor: getChartColors().secondaryAlpha,
                    borderColor: getChartColors().secondary,
                    borderWidth: 1
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                indexAxis: 'y',
                scales: {
                    x: {
                        beginAtZero: true,
                        ticks: {
                            color: getChartColors().text,
                            callback: function(value) {
                                return '$' + value.toFixed(4);
                            }
                        },
                        grid: {
                            color: getChartColors().grid
                        }
                    },
                    y: {
                        ticks: {
                            color: getChartColors().text,
                            autoSkip: false,
                            font: {
                                size: 11
                            }
                        },
                        grid: {
                            color: getChartColors().grid
                        }
                    }
                },
                plugins: {
                    legend: {
                        labels: {
                            color: getChartColors().text
                        }
                    },
                    tooltip: {
                        backgroundColor: 'hsla(var(--bg-300), 0.9)',
                        titleColor: 'hsl(var(--text-100))',
                        bodyColor: 'hsl(var(--text-200))',
                        borderColor: 'hsl(var(--bg-400))',
                        borderWidth: 1,
                        callbacks: {
                            label: function(context) {
                                return '花费: $' + context.parsed.x.toFixed(6);
                            }
                        }
                    }
                }
            }
        });

        // Theme toggle function
        function toggleTheme() {
            currentTheme = currentTheme === 'dark' ? 'light' : 'dark';
            document.documentElement.setAttribute('data-mode', currentTheme);
            
            const themeIcon = document.getElementById('theme-icon');
            const themeText = document.querySelector('.theme-toggle span');
            
            if (currentTheme === 'light') {
                themeIcon.className = 'fas fa-moon';
                themeText.textContent = 'Dark Mode';
            } else {
                themeIcon.className = 'fas fa-sun';
                themeText.textContent = 'Light Mode';
            }
            
            // Update chart colors
            updateChartTheme();
        }
        
        function updateChartTheme() {
            const colors = getChartColors();
            
            // Update daily chart
            dailyChart.data.datasets[0].backgroundColor = colors.primaryAlpha;
            dailyChart.data.datasets[0].borderColor = colors.primary;
            dailyChart.data.datasets[0].pointBackgroundColor = colors.primary;
            dailyChart.data.datasets[0].pointBorderColor = colors.primary;
            
            dailyChart.options.scales.x.ticks.color = colors.text;
            dailyChart.options.scales.x.grid.color = colors.grid;
            dailyChart.options.scales.y.ticks.color = colors.text;
            dailyChart.options.scales.y.grid.color = colors.grid;
            dailyChart.options.plugins.legend.labels.color = colors.text;
            
            // Update conversation chart
            conversationChart.data.datasets[0].backgroundColor = colors.secondaryAlpha;
            conversationChart.data.datasets[0].borderColor = colors.secondary;
            
            conversationChart.options.scales.x.ticks.color = colors.text;
            conversationChart.options.scales.x.grid.color = colors.grid;
            conversationChart.options.scales.y.ticks.color = colors.text;
            conversationChart.options.scales.y.grid.color = colors.grid;
            conversationChart.options.plugins.legend.labels.color = colors.text;
            
            dailyChart.update();
            conversationChart.update();
        }

        // Privacy toggle function
        function togglePrivacy() {
            privacyMode = !privacyMode;
            const privacyButton = document.querySelector('.privacy-toggle');
            const privacyIcon = document.getElementById('privacy-icon');
            const privacyText = document.getElementById('privacy-text');
            const sensitiveElements = document.querySelectorAll('.privacy-sensitive');
            
            if (privacyMode) {
                // Enable privacy mode
                privacyButton.classList.add('active');
                privacyIcon.className = 'fas fa-eye-slash';
                privacyText.textContent = '分享模式';
                
                // Add blur to sensitive elements
                sensitiveElements.forEach(element => {
                    element.classList.add('privacy-blur');
                });
                
                // Update chart labels to be generic
                updateChartLabelsForPrivacy(true);
                
                // Update filter options to be generic
                updateFilterOptionsForPrivacy(true);
            } else {
                // Disable privacy mode
                privacyButton.classList.remove('active');
                privacyIcon.className = 'fas fa-eye';
                privacyText.textContent = '隐私模式';
                
                // Remove blur from sensitive elements
                sensitiveElements.forEach(element => {
                    element.classList.remove('privacy-blur');
                });
                
                // Restore original chart labels
                updateChartLabelsForPrivacy(false);
                
                // Restore original filter options
                updateFilterOptionsForPrivacy(false);
            }
        }
        
        // Update chart labels for privacy mode
        function updateChartLabelsForPrivacy(isPrivate) {
            if (isPrivate) {
                // Replace conversation titles with generic labels in bar chart
                const genericLabels = conversationChart.data.labels.map((label, index) => 
                    \`对话 #\${index + 1}\`
                );
                conversationChart.data.labels = genericLabels;
            } else {
                // Restore original labels
                const originalLabels = ${JSON.stringify(
                  chartData.map(c => c.label.substring(0, 50) + (c.label.length > 50 ? '...' : ''))
                )};
                conversationChart.data.labels = originalLabels;
            }
            conversationChart.update();
        }
        
        // Update filter options for privacy mode
        function updateFilterOptionsForPrivacy(isPrivate) {
            const projectOptions = document.querySelectorAll('.project-option');
            projectOptions.forEach((option, index) => {
                if (isPrivate) {
                    option.textContent = option.getAttribute('data-generic');
                } else {
                    option.textContent = option.getAttribute('data-original');
                }
            });
        }

        // Project filter functionality
        document.getElementById('projectFilter').addEventListener('change', function(e) {
            const selectedProject = e.target.value;
            
            // Filter conversations
            let filteredConversations = allConversations;
            if (selectedProject !== 'all') {
                filteredConversations = allConversations.filter(c => c.projectName === selectedProject);
            }
            
            // Update summary
            const totalCost = filteredConversations.reduce((sum, c) => sum + c.totalCost, 0);
            document.querySelector('.summary-value').textContent = '$' + totalCost.toFixed(4);
            document.querySelectorAll('.summary-value')[1].textContent = filteredConversations.length;
            document.querySelectorAll('.summary-value')[2].textContent = '$' + (totalCost / filteredConversations.length).toFixed(4);
            
            // Update daily chart
            const filteredDailyData = dailyDataByProject.map(day => {
                const filteredDayConversations = selectedProject === 'all' 
                    ? day.conversations 
                    : day.conversations.filter(c => c.projectName === selectedProject);
                
                return {
                    date: day.date,
                    cost: filteredDayConversations.reduce((sum, c) => sum + c.totalCost, 0)
                };
            });
            
            dailyChart.data.datasets[0].data = filteredDailyData.map(d => d.cost);
            dailyChart.update();
            
            // Update conversation chart
            const topFiltered = filteredConversations.slice(0, 20);
            conversationChart.data.labels = topFiltered.map(c => {
                const label = c.conversationTitle || c.conversationName.split('/').pop() || 'Unknown';
                return label.substring(0, 50) + (label.length > 50 ? '...' : '');
            });
            conversationChart.data.datasets[0].data = topFiltered.map(c => c.totalCost);
            conversationChart.update();
            
            // Update table
            const tbody = document.querySelector('#conversationTable tbody');
            tbody.innerHTML = topFiltered.map((conv, index) => \`
                <tr data-project="\${conv.projectName}">
                    <td class="conversation-title privacy-sensitive \${privacyMode ? 'privacy-blur' : ''}" title="\${conv.conversationTitle}">\${conv.conversationTitle}</td>
                    <td class="project-name privacy-sensitive \${privacyMode ? 'privacy-blur' : ''}">\${(conv.conversationName.split('/').pop() || conv.projectName).replace(/-Users-haleclipse-WorkSpace-/, '')}</td>
                    <td class="cost">$\${conv.totalCost.toFixed(6)}</td>
                    <td style="color: hsl(var(--text-200));">\${conv.messageCount}</td>
                    <td style="color: hsl(var(--text-200));">\${conv.duration.toFixed(1)} 分钟</td>
                    <td style="color: hsl(var(--text-300)); font-family: 'Fira Code', monospace; font-size: 0.875rem;">\${conv.startTime ? conv.startTime.toLocaleDateString() : 'Unknown'}</td>
                </tr>
            \`).join('');
        });
    </script>
</body>
</html>`;

  const outputPath = path.join(os.tmpdir(), `claude-costs-report-${Date.now()}.html`);
  fs.writeFileSync(outputPath, html);
  console.log(`\nHTML report generated: ${outputPath}`);
  return outputPath;
}

function displaySummary(conversations) {
  const conversationsWithCosts = conversations.filter(c => c.totalCost > 0);
  const totalCost = conversationsWithCosts.reduce((sum, c) => sum + c.totalCost, 0);

  console.log('\n=== Claude Conversation Cost Summary ===\n');
  console.log(`Total Cost: $${totalCost.toFixed(4)}`);
  console.log(`Total Conversations with Costs: ${conversationsWithCosts.length}`);
  console.log(`Total Conversations Analyzed: ${conversations.length}`);
  console.log(
    `Average Cost per Conversation: $${(totalCost / conversationsWithCosts.length).toFixed(4)}`
  );
  
  // Show project breakdown
  const projectStats = {};
  conversations.forEach(conv => {
    if (!projectStats[conv.projectName]) {
      projectStats[conv.projectName] = {
        total: 0,
        withCost: 0,
        totalCost: 0
      };
    }
    projectStats[conv.projectName].total++;
    if (conv.totalCost > 0) {
      projectStats[conv.projectName].withCost++;
      projectStats[conv.projectName].totalCost += conv.totalCost;
    }
  });
  
  console.log('\n=== Project Breakdown ===');
  Object.entries(projectStats)
    .sort((a, b) => b[1].totalCost - a[1].totalCost)
    .forEach(([project, stats]) => {
      const projectDisplay = project.replace(/-Users-haleclipse-WorkSpace-/, '');
      console.log(`\n${projectDisplay}:`);
      console.log(`  Conversations: ${stats.total} (${stats.withCost} with costs)`);
      console.log(`  Total Cost: $${stats.totalCost.toFixed(4)}`);
    });

  // Show top 5 with titles
  console.log('\nTop 5 Most Expensive Conversations:');
  conversationsWithCosts
    .sort((a, b) => b.totalCost - a.totalCost)
    .slice(0, 5)
    .forEach((conv, i) => {
      console.log(`${i + 1}. ${conv.conversationTitle}`);
      console.log(`   Project: ${conv.conversationName.split('/').pop() || conv.projectName}`);
      console.log(`   Cost: $${conv.totalCost.toFixed(6)}`);
      console.log(`   Date: ${conv.startTime ? conv.startTime.toLocaleDateString() : 'Unknown'}`);
    });
}

// Main execution
async function main() {
  console.log('Analyzing Claude conversation costs...\n');

  const conversations = await analyzeAllConversations();

  if (conversations.length === 0) {
    console.log('No conversations found.');
    return;
  }

  displaySummary(conversations);
  const reportPath = createHTMLReport(conversations);

  console.log('\nOpening report in browser...');

  // Open the HTML file in the default browser
  const platform = process.platform;
  let cmd;
  if (platform === 'darwin') {
    cmd = `open "${reportPath}"`;
  } else if (platform === 'win32') {
    cmd = `start "" "${reportPath}"`;
  } else {
    cmd = `xdg-open "${reportPath}"`;
  }

  exec(cmd, err => {
    if (err) {
      console.error('Failed to open browser automatically.');
      console.log(`Please open the following file manually: ${reportPath}`);
    }
  });
}

main().catch(console.error);