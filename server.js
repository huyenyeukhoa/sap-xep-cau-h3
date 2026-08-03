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

// Load sets of questions
const rawSets = JSON.parse(fs.readFileSync(path.join(__dirname, 'questions.json'), 'utf8'));

// Server states
let gameState = 'IDLE'; // 'IDLE', 'EXAM', 'GRADING'
let activeSetId = '';
let activeQuestions = [];
let activeChoices = {};
let activeExample = {};
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

// Helper to compile admin dashboard state
function getAdminState() {
  const studentList = [];
  students.forEach((student, clientId) => {
    studentList.push({
      clientId,
      name: student.name,
      submitted: student.submitted,
      score: student.score,
      answers: student.answers,
      solvingTime: student.solvingTime,
      solvingTimeMs: student.solvingTimeMs,
      totalQuestions: activeQuestions.length
    });
  });

  // Calculate question statistics if in GRADING state
  let questionStats = [];
  if (gameState === 'GRADING' && activeQuestions.length > 0) {
    activeQuestions.forEach((q, idx) => {
      let correctCount = 0;
      let incorrectCount = 0;

      students.forEach((student) => {
        const studentAns = student.answers ? student.answers.find(a => a.q_index === idx) : null;
        if (studentAns && studentAns.user_answer === q.answer) {
          correctCount++;
        } else {
          incorrectCount++;
        }
      });

      const totalStudents = students.size;
      const errorRate = totalStudents > 0 ? (incorrectCount / totalStudents) * 100 : 0;

      questionStats.push({
        index: idx,
        question: q.question,
        answer: q.answer,
        correctCount,
        incorrectCount,
        errorRate: Math.round(errorRate * 10) / 10
      });
    });
  }

  // Get question sets metadata
  const questionSets = rawSets.map(s => ({
    setId: s.setId,
    setName: s.setName,
    questionCount: s.questions.length
  }));

  return {
    state: gameState,
    activeSetId,
    activeQuestionsCount: activeQuestions.length,
    students: studentList,
    questionSets,
    questionStats
  };
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
          const { setId } = msg.payload;
          const chosenSet = rawSets.find(s => s.setId === setId);
          
          if (chosenSet) {
            activeSetId = setId;
            activeQuestions = chosenSet.questions;
            activeChoices = chosenSet.choices;
            activeExample = chosenSet.example;
            gameState = 'EXAM';

            // Reset student submissions
            students.forEach(s => {
              s.submitted = false;
              s.answers = [];
              s.score = 0;
              s.solvingTime = '';
              s.solvingTimeMs = 0;
              s.gradedDetails = [];
            });

            // Send questions to students
            broadcastToStudents({
              type: 'START_EXAM',
              choices: activeChoices,
              example: activeExample,
              setId: activeSetId,
              questions: activeQuestions.map(q => ({
                index: q.index,
                question: q.question,
                paragraph: q.paragraph,
                options: q.options,
                audio: q.audio,
                content: q.content
              }))
            });

            // Update Admin
            sendToAdmin({
              type: 'STATE_UPDATE',
              ...getAdminState()
            });
          }

        } else if (msg.type === 'GRADE_EXAM') {
          gameState = 'GRADING';

          // Grade every student's submission
          students.forEach((student) => {
            let correctCount = 0;
            const details = [];

            activeQuestions.forEach((q, idx) => {
              const studentAnsObj = student.answers.find(a => a.q_index === idx);
              const userAns = studentAnsObj ? studentAnsObj.user_answer : '';
              const isCorrect = userAns === q.answer;

              if (isCorrect) {
                correctCount++;
              }

              details.push({
                index: idx,
                question: q.question,
                paragraph: q.paragraph,
                highlights: q.highlights,
                correctAnswer: q.answer,
                userAnswer: userAns,
                isCorrect: isCorrect,
                pinyin: q.pinyin,
                vietnamese: q.vietnamese,
                explanation: q.explanation,
                choiceText: q.options ? q.options[q.answer] : (activeChoices[q.answer] || ""),
                audio: q.audio,
                transcript: q.transcript,
                content: q.content
              });
            });

            // Score out of 10 dynamically (rounded to 1 decimal place)
            const finalScore = activeQuestions.length > 0 ? Math.round((correctCount / activeQuestions.length) * 10 * 10) / 10 : 0;

            student.score = finalScore;
            student.gradedDetails = details;

            // Send results to this student
            if (student.ws.readyState === WebSocket.OPEN) {
              student.ws.send(JSON.stringify({
                type: 'EXAM_RESULT',
                score: finalScore,
                total: 10,
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
          activeSetId = '';
          activeQuestions = [];
          activeChoices = {};
          activeExample = {};
          
          students.forEach(s => {
            s.submitted = false;
            s.answers = [];
            s.score = 0;
            s.solvingTime = '';
            s.solvingTimeMs = 0;
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
          students.forEach((student) => {
            student.name = '';
            student.submitted = false;
            student.answers = [];
            student.score = 0;
            student.solvingTime = '';
            student.solvingTimeMs = 0;
            student.gradedDetails = [];
          });
          
          broadcastToStudents({
            type: 'FORCE_RE_REGISTER'
          });

          sendToAdmin({
            type: 'STATE_UPDATE',
            ...getAdminState()
          });
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
        ws.send(JSON.stringify({
          type: 'START_EXAM',
          choices: activeChoices,
          example: activeExample,
          questions: activeQuestions.map(q => ({
            index: q.index,
            question: q.question
          })),
          name: student.name,
          answers: student.answers
        }));
      }
    } else if (gameState === 'GRADING') {
      ws.send(JSON.stringify({
        type: 'EXAM_RESULT',
        score: student.score,
        total: 10,
        details: student.gradedDetails
      }));
    }

    ws.on('message', (message) => {
      try {
        const msg = JSON.parse(message);

        if (msg.type === 'REGISTER') {
          student.name = msg.payload.name;
          console.log(`Student registered name: ${student.name} (${clientId})`);
          
          sendToAdmin({
            type: 'STATE_UPDATE',
            ...getAdminState()
          });

        } else if (msg.type === 'UPDATE_PROGRESS') {
          student.answers = msg.payload.answers;
          
          sendToAdmin({
            type: 'STATE_UPDATE',
            ...getAdminState()
          });
        } else if (msg.type === 'SUBMIT_ANSWERS') {
          student.submitted = true;
          student.answers = msg.payload.answers;
          student.solvingTime = msg.payload.solvingTime;
          student.solvingTimeMs = msg.payload.solvingTimeMs;
          console.log(`Student ${student.name} submitted answers in ${student.solvingTime}.`);

          ws.send(JSON.stringify({ type: 'WAITING_FOR_GRADING' }));

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
    });
  }
});

// Serve HTML pages
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'student.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Start Server
server.listen(PORT, () => {
  const localIp = getLocalIpAddress();
  console.log('\n======================================================');
  console.log(`🚀 Máy chủ luyện đọc HSK 3 - Nối cặp đối thoại đang chạy!`);
  console.log(`💻 Bảng giáo viên: http://localhost:${PORT}/admin`);
  console.log(`📱 Link học viên:  http://${localIp}:${PORT}`);
  console.log('======================================================\n');
});
