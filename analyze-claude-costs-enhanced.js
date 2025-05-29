#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const os = require('os');
const { exec } = require('child_process');

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
      
      // Extract cost data
      if (message.type === 'assistant' && message.costUSD) {
        totalCost += message.costUSD;
        messageCount++;
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
  const projectDirs = fs.readdirSync(claudeProjectsDir)
    .filter(dir => fs.statSync(path.join(claudeProjectsDir, dir)).isDirectory());

  let processedCount = 0;
  const totalFiles = projectDirs.reduce((acc, dir) => {
    const projectPath = path.join(claudeProjectsDir, dir);
    return acc + fs.readdirSync(projectPath).filter(f => f.endsWith('.jsonl')).length;
  }, 0);

  for (const projectDir of projectDirs) {
    const projectPath = path.join(claudeProjectsDir, projectDir);
    const jsonlFiles = fs.readdirSync(projectPath)
      .filter(file => file.endsWith('.jsonl'));

    for (const jsonlFile of jsonlFiles) {
      const filePath = path.join(projectPath, jsonlFile);
      processedCount++;
      process.stdout.write(`\rProcessing: ${processedCount}/${totalFiles} files...`);
      
      try {
        const conversation = await parseJSONLFile(filePath);
        conversation.projectName = projectDir;
        conversations.push(conversation);
      } catch (e) {
        // Silent error handling
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
<html>
<head>
    <title>Claude Conversation Cost Analysis</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/date-fns@2.29.3/index.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/chartjs-adapter-date-fns@3.0.0/dist/chartjs-adapter-date-fns.bundle.min.js"></script>
    <style>
        body {
            font-family: Arial, sans-serif;
            margin: 20px;
            background-color: #f5f5f5;
        }
        .container {
            max-width: 1400px;
            margin: 0 auto;
            background-color: white;
            padding: 20px;
            border-radius: 8px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        h1 {
            color: #333;
            text-align: center;
        }
        .summary {
            display: flex;
            justify-content: space-around;
            margin: 20px 0;
            text-align: center;
        }
        .summary-item {
            padding: 20px;
            background-color: #f8f9fa;
            border-radius: 8px;
            flex: 1;
            margin: 0 10px;
        }
        .summary-value {
            font-size: 2em;
            font-weight: bold;
            color: #007bff;
        }
        .chart-container {
            position: relative;
            height: 400px;
            margin: 30px 0;
        }
        .daily-chart-container {
            position: relative;
            height: 300px;
            margin: 30px 0;
        }
        .filter-container {
            margin: 20px 0;
            padding: 15px;
            background-color: #f8f9fa;
            border-radius: 8px;
        }
        .filter-container label {
            margin-right: 10px;
            font-weight: bold;
        }
        .filter-container select {
            padding: 5px 10px;
            border-radius: 4px;
            border: 1px solid #ddd;
            margin-right: 20px;
        }
        table {
            width: 100%;
            border-collapse: collapse;
            margin-top: 20px;
        }
        th, td {
            text-align: left;
            padding: 12px;
            border-bottom: 1px solid #ddd;
        }
        th {
            background-color: #f8f9fa;
            font-weight: bold;
        }
        tr:hover {
            background-color: #f5f5f5;
        }
        .cost {
            font-weight: bold;
            color: #28a745;
        }
        .conversation-title {
            max-width: 400px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .clickable {
            cursor: pointer;
            text-decoration: underline;
            color: #007bff;
        }
        .clickable:hover {
            color: #0056b3;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>Claude Conversation Cost Analysis</h1>
        
        <div class="summary">
            <div class="summary-item">
                <div>Total Cost</div>
                <div class="summary-value">$${totalCost.toFixed(4)}</div>
            </div>
            <div class="summary-item">
                <div>Total Conversations</div>
                <div class="summary-value">${conversationsWithCosts.length}</div>
            </div>
            <div class="summary-item">
                <div>Average Cost</div>
                <div class="summary-value">$${(totalCost / conversationsWithCosts.length).toFixed(4)}</div>
            </div>
        </div>

        <div class="filter-container">
            <label for="projectFilter">Filter by Project:</label>
            <select id="projectFilter">
                <option value="all">All Projects</option>
                ${uniqueProjects.map(p => `<option value="${p}">${p.replace(/-Users-philipp-dev-/, '')}</option>`).join('')}
            </select>
        </div>

        <h2>Daily Cost Breakdown (Last 30 Days)</h2>
        <div class="daily-chart-container">
            <canvas id="dailyChart"></canvas>
        </div>

        <h2>Top 20 Most Expensive Conversations</h2>
        <div class="chart-container">
            <canvas id="costChart"></canvas>
        </div>

        <table id="conversationTable">
            <thead>
                <tr>
                    <th>Conversation Title</th>
                    <th>Project</th>
                    <th>Cost</th>
                    <th>Messages</th>
                    <th>Duration</th>
                    <th>Date</th>
                </tr>
            </thead>
            <tbody>
                ${conversationsWithCosts.slice(0, 20).map(conv => `
                    <tr data-project="${conv.projectName}">
                        <td class="conversation-title" title="${conv.conversationTitle}">${conv.conversationTitle}</td>
                        <td>${conv.conversationName.split('/').pop() || conv.projectName}</td>
                        <td class="cost">$${conv.totalCost.toFixed(6)}</td>
                        <td>${conv.messageCount}</td>
                        <td>${conv.duration.toFixed(1)} min</td>
                        <td>${conv.startTime ? conv.startTime.toLocaleDateString() : 'Unknown'}</td>
                    </tr>
                `).join('')}
            </tbody>
        </table>
    </div>

    <script>
        // Store all conversation data for filtering
        const allConversations = ${JSON.stringify(conversationsWithCosts)};
        const dailyDataByProject = ${JSON.stringify(last30DaysData)};
        
        // Daily cost chart
        const dailyCtx = document.getElementById('dailyChart').getContext('2d');
        const dailyChart = new Chart(dailyCtx, {
            type: 'line',
            data: {
                labels: ${JSON.stringify(last30DaysData.map(d => d.date))},
                datasets: [{
                    label: 'Daily Cost (USD)',
                    data: ${JSON.stringify(last30DaysData.map(d => d.cost))},
                    backgroundColor: 'rgba(54, 162, 235, 0.2)',
                    borderColor: 'rgba(54, 162, 235, 1)',
                    borderWidth: 2,
                    fill: true,
                    tension: 0.1
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
                        }
                    },
                    y: {
                        beginAtZero: true,
                        ticks: {
                            callback: function(value) {
                                return '$' + value.toFixed(2);
                            }
                        }
                    }
                },
                plugins: {
                    tooltip: {
                        callbacks: {
                            label: function(context) {
                                const dayData = dailyDataByProject[context.dataIndex];
                                const lines = ['Cost: $' + context.parsed.y.toFixed(4)];
                                if (dayData && dayData.conversations.length > 0) {
                                    lines.push('Conversations: ' + dayData.conversations.length);
                                    lines.push('---');
                                    dayData.conversations.slice(0, 3).forEach(conv => {
                                        lines.push(conv.conversationTitle.substring(0, 40) + '...: $' + conv.totalCost.toFixed(2));
                                    });
                                    if (dayData.conversations.length > 3) {
                                        lines.push('... and ' + (dayData.conversations.length - 3) + ' more');
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
                labels: ${JSON.stringify(chartData.map(c => c.label.substring(0, 50) + (c.label.length > 50 ? '...' : '')))},
                datasets: [{
                    label: 'Cost (USD)',
                    data: ${JSON.stringify(chartData.map(c => c.cost))},
                    backgroundColor: 'rgba(54, 162, 235, 0.8)',
                    borderColor: 'rgba(54, 162, 235, 1)',
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
                            callback: function(value) {
                                return '$' + value.toFixed(4);
                            }
                        }
                    },
                    y: {
                        ticks: {
                            autoSkip: false,
                            font: {
                                size: 11
                            }
                        }
                    }
                },
                plugins: {
                    tooltip: {
                        callbacks: {
                            label: function(context) {
                                return 'Cost: $' + context.parsed.x.toFixed(6);
                            }
                        }
                    }
                }
            }
        });

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
            tbody.innerHTML = topFiltered.map(conv => \`
                <tr data-project="\${conv.projectName}">
                    <td class="conversation-title" title="\${conv.conversationTitle}">\${conv.conversationTitle}</td>
                    <td>\${conv.conversationName.split('/').pop() || conv.projectName}</td>
                    <td class="cost">$\${conv.totalCost.toFixed(6)}</td>
                    <td>\${conv.messageCount}</td>
                    <td>\${conv.duration.toFixed(1)} min</td>
                    <td>\${conv.startTime ? conv.startTime.toLocaleDateString() : 'Unknown'}</td>
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
  console.log(`Total Conversations: ${conversationsWithCosts.length}`);
  console.log(`Average Cost per Conversation: $${(totalCost / conversationsWithCosts.length).toFixed(4)}`);
  
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
  
  exec(cmd, (err) => {
    if (err) {
      console.error('Failed to open browser automatically.');
      console.log(`Please open the following file manually: ${reportPath}`);
    }
  });
}

main().catch(console.error);