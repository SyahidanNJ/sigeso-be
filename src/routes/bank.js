const express = require('express');
const { auth, roles } = require('../middleware/auth');
const { asyncH, GURU } = require('../controllers/bantuan');
const c = require('../controllers/bank');

const r = express.Router();
r.use(auth);

r.get('/questions', asyncH(c.listQuestions));
r.post('/questions', roles(...GURU), asyncH(c.createQuestion));
r.delete('/questions/:id', roles(...GURU), asyncH(c.deleteQuestion));

r.post('/generate', roles(...GURU), asyncH(c.generateQuestions));

r.get('/exams', asyncH(c.listExams));
r.post('/exams', roles(...GURU), asyncH(c.createExam));
r.get('/exams/:id/items', asyncH(c.listExamItems));
r.put('/exams/:id/items', roles(...GURU), asyncH(c.setExamItems));

r.get('/llm-usage', roles('superadmin', 'admin'), asyncH(c.llmUsage));

module.exports = r;