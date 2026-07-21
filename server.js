const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const os = require('os');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;

// Load questions from flat JSON
const rawQuestions = JSON.parse(fs.readFileSync(path.join(__dirname, 'questions.json'), 'utf8'));

// Server states
let gameState = 'IDLE'; // 'IDLE', 'EXAM', 'GRADING'
let activeQuestions = [];
let students = new Map(); // clientId -> student object
let adminWs = null;

app.use(express.static(path.join(__dirname, 'public')));

// Helper to get local network IP address
function getLocalIpAddress() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

// Helper to broadcast to all connected student clients
function broadcastToStudents(message) {
  const data = JSON.stringify(message);
  students.forEach((student) => {
    if (student.ws.readyState === WebSocket.OPEN) {
      student.ws.send(data);
    }
  });
}

// Helper to send message to admin
function sendToAdmin(message) {
  if (adminWs && adminWs.readyState === WebSocket.OPEN) {
    adminWs.send(JSON.stringify(message));
  }
}

// Helper to get count of questions per category
function getCategoryCounts() {
  const counts = { all: rawQuestions.length };
  rawQuestions.forEach(q => {
    counts[q.category] = (counts[q.category] || 0) + 1;
  });
  return counts;
}

// Helper to compile admin dashboard state
function getAdminState() {
  const studentList = [];
  students.forEach((student, clientId) => {
    studentList.push({
      clientId,
      name: student.name,
      submitted: student.submitted,
      score: student.score,
      currentIdx: student.currentIdx !== undefined ? student.currentIdx : -1,
      totalQuestions: activeQuestions.length
    });
  });

  // Calculate question statistics if in GRADING state
  let questionStats = [];
  if (gameState === 'GRADING' && activeQuestions.length > 0) {
    activeQuestions.forEach((q, idx) => {
      let correctCount = 0;
      let partialCount = 0;
      let incorrectCount = 0;
      let totalScore = 0;

      students.forEach((student) => {
        const detail = student.gradedDetails ? student.gradedDetails.find(d => d.index === idx) : null;
        const score = detail ? detail.score : 0;
        totalScore += score;
        if (score === 10) {
          correctCount++;
        } else if (score > 0) {
          partialCount++;
        } else {
          incorrectCount++;
        }
      });

      const totalStudents = students.size;
      const errorRate = totalStudents > 0 ? ((incorrectCount + partialCount) / totalStudents) * 100 : 0;
      const averageScore = totalStudents > 0 ? (totalScore / totalStudents) : 0;

      questionStats.push({
        index: idx,
        scrambled: q.scrambled,
        answer: q.answer,
        category: q.category,
        correctCount,
        partialCount,
        incorrectCount,
        errorRate: Math.round(errorRate * 10) / 10,
        averageScore: Math.round(averageScore * 10) / 10
      });
    });

    // Sort by errorRate descending (most incorrect first)
    questionStats.sort((a, b) => b.errorRate - a.errorRate);
  }

  return {
    state: gameState,
    activeQuestionsCount: activeQuestions.length,
    students: studentList,
    categoryCounts: getCategoryCounts(),
    questionStats: questionStats
  };
}

// Helper to normalize and check Chinese answers
function checkAnswer(userAnswer, correctAnswer) {
  // Strip whitespace and common Chinese punctuation
  const normalize = (str) => {
    if (!str) return '';
    return str.replace(/\s+/g, '').replace(/[。？！，、?!!,.]/g, '');
  };
  return normalize(userAnswer) === normalize(correctAnswer);
}

// Helper to reconstruct correct block sequence from scrambled and correct answer
function getCorrectBlockSequence(scrambled, correctAnswer) {
  const blocks = scrambled.match(/\[([^\]]+)\]/g).map(w => w.slice(1, -1));
  const cleanAns = correctAnswer.replace(/\s+/g, '').replace(/[。？！，、?!!,.]/g, '');
  
  let remaining = cleanAns;
  const correctSeq = [];
  const availableBlocks = [...blocks];
  
  while (remaining.length > 0 && availableBlocks.length > 0) {
    let found = false;
    for (let i = 0; i < availableBlocks.length; i++) {
      const block = availableBlocks[i];
      if (remaining.startsWith(block)) {
        correctSeq.push(block);
        remaining = remaining.substring(block.length);
        availableBlocks.splice(i, 1);
        found = true;
        break;
      }
    }
    if (!found) break;
  }
  
  if (availableBlocks.length > 0) {
    correctSeq.push(...availableBlocks);
  }
  return correctSeq;
}

// Helper to compute Longest Common Subsequence (LCS) length
function getLcsLength(seq1, seq2) {
  const m = seq1.length;
  const n = seq2.length;
  const dp = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));
  
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (seq1[i - 1] === seq2[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }
  return dp[m][n];
}

wss.on('connection', (ws, req) => {
  // Determine if it's admin or student
  const urlParams = new URLSearchParams(req.url.split('?')[1]);
  const isAdmin = urlParams.get('role') === 'admin';
  const clientId = urlParams.get('clientId') || Math.random().toString(36).substr(2, 9);

  if (isAdmin) {
    console.log('👑 Admin dashboard connected.');
    adminWs = ws;
    // Send current state
    ws.send(JSON.stringify({
      type: 'STATE_UPDATE',
      ...getAdminState()
    }));

    ws.on('message', (message) => {
      try {
        const msg = JSON.parse(message);
        console.log('Admin Action:', msg.type);

        if (msg.type === 'INIT_EXAM') {
          // Select questions based on configuration
          const { numQuestions, categoriesFilter } = msg.payload;

          const MIX_CATEGORIES = [
            "Câu liên động / Cách thức hành động",
            "Cấu trúc 马上就要... / 快要...",
            "Câu song tân ngữ / Kiêm ngữ",
            "Câu có Động từ năng nguyện (想/喜欢/会/能)",
            "Câu vị ngữ tính từ / Trạng thái (很/非常/太)"
          ];
          
          let filtered = [...rawQuestions];
          if (categoriesFilter && categoriesFilter !== 'all') {
            if (categoriesFilter === 'mix') {
              filtered = rawQuestions.filter(q => MIX_CATEGORIES.includes(q.category));
            } else {
              filtered = rawQuestions.filter(q => q.category === categoriesFilter);
            }
          }

          // Seeded shuffle: same day => same order for all students
          const today = new Date();
          const seed = today.getFullYear() * 10000 + (today.getMonth() + 1) * 100 + today.getDate();
          function seededRandom(s) {
            let x = Math.sin(s) * 10000;
            return x - Math.floor(x);
          }
          filtered.sort((a, b) => {
            const ia = rawQuestions.indexOf(a);
            const ib = rawQuestions.indexOf(b);
            return seededRandom(seed + ia) - seededRandom(seed + ib);
          });
          activeQuestions = filtered.slice(0, Math.min(numQuestions, filtered.length));

          
          gameState = 'EXAM';

          // Reset all registered student submissions
          students.forEach(s => {
            s.submitted = false;
            s.answers = [];
            s.score = 0;
            s.gradedDetails = [];
          });

          // Send questions (scrambled only!) to students
          const studentQuestions = activeQuestions.map((q, idx) => ({
            index: idx,
            scrambled: q.scrambled
          }));

          broadcastToStudents({
            type: 'START_EXAM',
            questions: studentQuestions
          });

          // Update Admin
          sendToAdmin({
            type: 'STATE_UPDATE',
            ...getAdminState()
          });

        } else if (msg.type === 'GRADE_EXAM') {
          gameState = 'GRADING';

          // Grade every student's submission
          students.forEach((student) => {
            let totalWeightedScore = 0;
            const details = [];

            activeQuestions.forEach((q, idx) => {
              const studentAnsObj = student.answers.find(a => a.q_index === idx);
              const userAnsText = studentAnsObj ? studentAnsObj.user_answer : '';
              const userSeq = studentAnsObj && studentAnsObj.user_blocks ? studentAnsObj.user_blocks : [];

              // Reconstruct correct sequence
              const correctSeq = getCorrectBlockSequence(q.scrambled, q.answer);
              
              // Calculate LCS
              const lcsLen = getLcsLength(correctSeq, userSeq);
              const maxLen = correctSeq.length;
              
              // Calculate partial credit out of 10
              let questionScore = 0;
              if (maxLen > 0) {
                questionScore = (lcsLen / maxLen) * 10;
              }
              // Round to 1 decimal place
              questionScore = Math.round(questionScore * 10) / 10;
              totalWeightedScore += questionScore;

              details.push({
                index: idx,
                scrambled: q.scrambled,
                correctAnswer: q.answer,
                userAnswer: userAnsText,
                score: questionScore, // Question score out of 10
                pinyin: q.pinyin,
                vietnamese: q.vietnamese,
                category: q.category
              });
            });

            // Calculate student average score out of 10
            let finalScore = 0;
            if (activeQuestions.length > 0) {
              finalScore = totalWeightedScore / activeQuestions.length;
            }
            finalScore = Math.round(finalScore * 10) / 10; // Round to 1 decimal place

            student.score = finalScore;
            student.gradedDetails = details;

            // Send results to this student
            if (student.ws.readyState === WebSocket.OPEN) {
              student.ws.send(JSON.stringify({
                type: 'EXAM_RESULT',
                score: finalScore,
                total: 10, // Total scale is always 10
                details: details
              }));
            }
          });

          // Update Admin with final leaderboard
          sendToAdmin({
            type: 'STATE_UPDATE',
            ...getAdminState()
          });

        } else if (msg.type === 'RESET_EXAM') {
          gameState = 'IDLE';
          activeQuestions = [];
          students.forEach(s => {
            s.submitted = false;
            s.answers = [];
            s.score = 0;
            s.gradedDetails = [];
          });

          broadcastToStudents({
            type: 'RESET_EXAM'
          });

          sendToAdmin({
            type: 'STATE_UPDATE',
            ...getAdminState()
          });
        } else if (msg.type === 'FORCE_RESET_NAMES') {
          console.log('Admin Action: FORCE_RESET_NAMES');
          students.forEach((student) => {
            student.name = '';
            student.submitted = false;
            student.answers = [];
            student.score = 0;
            student.gradedDetails = [];
            student.currentIdx = -1;
          });
          
          broadcastToStudents({
            type: 'FORCE_RE_REGISTER'
          });

          sendToAdmin({
            type: 'STATE_UPDATE',
            ...getAdminState()
          });
        } else if (msg.type === 'UNLOCK_STUDENT') {
          const targetId = msg.payload.clientId;
          const student = students.get(targetId);
          if (student) {
            student.submitted = false;
            student.score = 0;
            student.gradedDetails = [];
            console.log(`Admin Action: UNLOCK_STUDENT for student ${student.name}`);
            
            if (student.ws.readyState === 1) { // WebSocket.OPEN
              student.ws.send(JSON.stringify({
                type: 'RESTORE_EXAM',
                answers: student.answers
              }));
            }
            
            sendToAdmin({
              type: 'STATE_UPDATE',
              ...getAdminState()
            });
          }
        } else if (msg.type === 'GET_CATEGORY_QUESTIONS') {
          const cat = msg.payload.category;
          const matched = [];
          rawQuestions.forEach((q, idx) => {
            if (q.category === cat) {
              matched.push({
                globalIndex: idx,
                scrambled: q.scrambled,
                answer: q.answer,
                pinyin: q.pinyin || '',
                vietnamese: q.vietnamese || '',
                category: q.category
              });
            }
          });
          ws.send(JSON.stringify({
            type: 'CATEGORY_QUESTIONS_RESPONSE',
            category: cat,
            questions: matched
          }));
        } else if (msg.type === 'UPDATE_QUESTION') {
          const { globalIndex, scrambled, answer, pinyin, vietnamese, category } = msg.payload;
          if (globalIndex >= 0 && globalIndex < rawQuestions.length) {
            rawQuestions[globalIndex] = {
              scrambled,
              answer,
              pinyin,
              vietnamese,
              category,
              sources: rawQuestions[globalIndex].sources || []
            };
            
            fs.writeFileSync(
              path.join(__dirname, 'questions.json'),
              JSON.stringify(rawQuestions, null, 2),
              'utf8'
            );
            console.log(`Question at index ${globalIndex} updated by admin.`);
            
            ws.send(JSON.stringify({
              type: 'UPDATE_QUESTION_SUCCESS',
              globalIndex,
              category
            }));

            sendToAdmin({
              type: 'STATE_UPDATE',
              ...getAdminState()
            });

            // Refresh questions list for the admin
            const matched = [];
            rawQuestions.forEach((q, idx) => {
              if (q.category === category) {
                matched.push({
                  globalIndex: idx,
                  scrambled: q.scrambled,
                  answer: q.answer,
                  pinyin: q.pinyin || '',
                  vietnamese: q.vietnamese || '',
                  category: q.category
                });
              }
            });
            ws.send(JSON.stringify({
              type: 'CATEGORY_QUESTIONS_RESPONSE',
              category: category,
              questions: matched
            }));
          }
        }
      } catch (err) {
        console.error('Error handling admin message:', err);
      }
    });

    ws.on('close', () => {
      console.log('Admin dashboard disconnected.');
      if (adminWs === ws) adminWs = null;
    });

  } else {
    // Student connection
    console.log(`Student connecting: client ${clientId}`);
    
    // Check if re-registering
    let student = students.get(clientId);
    if (!student) {
      student = {
        ws: ws,
        name: '',
        submitted: false,
        answers: [],
        score: 0,
        gradedDetails: []
      };
      students.set(clientId, student);
    } else {
      student.ws = ws; // Update connection
    }

    // Send current status to student
    if (gameState === 'IDLE') {
      ws.send(JSON.stringify({ type: 'WAITING_FOR_EXAM' }));
    } else if (gameState === 'EXAM') {
      if (student.submitted) {
        ws.send(JSON.stringify({ type: 'WAITING_FOR_GRADING' }));
      } else {
        const studentQuestions = activeQuestions.map((q, idx) => ({
          index: idx,
          scrambled: q.scrambled
        }));
        ws.send(JSON.stringify({
          type: 'START_EXAM',
          questions: studentQuestions,
          name: student.name,
          answers: student.answers // Send existing progress to student
        }));
      }
    } else if (gameState === 'GRADING') {
      ws.send(JSON.stringify({
        type: 'EXAM_RESULT',
        score: student.score,
        total: activeQuestions.length,
        details: student.gradedDetails
      }));
    }

    ws.on('message', (message) => {
      try {
        const msg = JSON.parse(message);

        if (msg.type === 'REGISTER') {
          student.name = msg.payload.name;
          console.log(`Student registered name: ${student.name} (${clientId})`);
          
          // Notify admin of student connection/update
          sendToAdmin({
            type: 'STATE_UPDATE',
            ...getAdminState()
          });

        } else if (msg.type === 'UPDATE_PROGRESS') {
          student.answers = msg.payload.answers;
          student.currentIdx = msg.payload.currentIdx !== undefined ? msg.payload.currentIdx : -1;
          console.log(`Student ${student.name} updated progress in real-time. Question: ${student.currentIdx}`);
          
          // Notify admin of progress update in real-time
          sendToAdmin({
            type: 'STATE_UPDATE',
            ...getAdminState()
          });
        } else if (msg.type === 'SUBMIT_ANSWERS') {
          student.submitted = true;
          student.answers = msg.payload.answers;
          console.log(`Student ${student.name} submitted answers.`);

          ws.send(JSON.stringify({ type: 'WAITING_FOR_GRADING' }));

          // Notify admin
          sendToAdmin({
            type: 'STATE_UPDATE',
            ...getAdminState()
          });
        }
      } catch (err) {
        console.error('Error handling student message:', err);
      }
    });

    ws.on('close', () => {
      console.log(`Student disconnected: ${student.name || clientId}`);
      // Note: we do NOT delete the student object so they can reconnect and keep their answers/results!
    });
  }
});

// Serve files
app.get('/', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.sendFile(path.join(__dirname, 'public', 'student.html'));
});

app.get('/admin', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Start HTTP Server
server.listen(PORT, () => {
  const localIp = getLocalIpAddress();
  console.log('\n======================================================');
  console.log(`🚀 Máy chủ học tập HSK 3 đang chạy!`);
  console.log(`💻 Giáo viên truy cập: http://localhost:${PORT}/admin`);
  console.log(`📱 Học viên truy cập:  http://${localIp}:${PORT}`);
  console.log('======================================================\n');
});
