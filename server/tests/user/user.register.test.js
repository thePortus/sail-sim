const app = require('../../app.js');
const supertest = require('supertest');
const requestWithSupertest = supertest(app);

describe('User Endpoints', () => {

  let ownerToken = '';
  let userId = 'TestingUser';

  beforeAll(async () => {
    const ownerResponse = await supertest(app).post('/api/user/login')
      .send({
        username: process.env.OWNER_USERNAME || 'jesuit-catalogs-owner',
        password: process.env.OWNER_PASSWORD || 'password'
      });
    ownerToken = ownerResponse.body.token;
  });

  afterEach(async () => {
    await requestWithSupertest.delete(`/api/user/delete/${userId}`)
      .set('Authorization', `${ownerToken}`);
  });

  it('POST /api/user/register should register a user', async () => {
    const res = await requestWithSupertest.post('/api/user/register')
      .send({
        username: userId,
        password: 'password',
        callsign: userId
      });
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
  });

  it('POST /api/user/register should reject a request without a username', async () => {
    const res = await requestWithSupertest.post('/api/user/register')
      .send({
        password: 'password',
        callsign: 'sample2@gmail.com'
      });
    expect(res.status).toEqual(500);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', ['Must contain a \'username\' field!']);
  });

  it('POST /api/user/register should reject a request without a password', async () => {
    const res = await requestWithSupertest.post('/api/user/register')
      .send({
        username: userId,
        callsign: userId
      });
    expect(res.status).toEqual(500);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', ['Must contain a \'password\' field!']);
  });

  it('POST /api/user/register should reject a request without a callsign', async () => {
    const res = await requestWithSupertest.post('/api/user/register')
      .send({
        username: userId,
        password: 'password'
      });
    expect(res.status).toEqual(500);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', ['Must contain a \'callsign\' field!']);
  });

  it('POST /api/user/register should reject a request with a duplicate username', async () => {
    await requestWithSupertest.post('/api/user/register')
      .send({
        username: userId,
        callsign: userId,
        password: 'password'
      });
    const res = await requestWithSupertest.post('/api/user/register')
      .send({
        username: userId,
        callsign: userId,
        password: 'password'
      });
    expect(res.status).toEqual(500);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', ['Username or callsign already exists.']);
  });

  it('POST /api/user/register should reject a request with a duplicate callsign', async () => {
    await requestWithSupertest.post('/api/user/register')
      .send({
        username: 'TestingUser',
        callsign: 'sample@gmail.com',
        password: 'password'
      });
    const res = await requestWithSupertest.post('/api/user/register')
      .send({
        username: 'TestingUser2',
        callsign: 'sample@gmail.com',
        password: 'password'
      });
    expect(res.status).toEqual(500);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', ['Username or callsign already exists.']);
  });

  it('POST /api/user/register should reject a request with a non-string for username', async () => {
    const res = await requestWithSupertest.post('/api/user/register')
      .send({
        username: 1,
        password: 'password',
        callsign: 'sample2@gmail.com'
      });
    expect(res.status).toEqual(500);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', ['\'username\' must be of type \'string\'!']);
  });

  it('POST /api/user/register should reject a request with a non-string for password', async () => {
    const res = await requestWithSupertest.post('/api/user/register')
      .send({
        username: userId,
        password: 1,
        callsign: 'test@test.com'
      });
    expect(res.status).toEqual(500);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', ['\'password\' must be of type \'string\'!']);
  });

  it('POST /api/user/register should reject a request with a non-string for callsign', async () => {
    const res = await requestWithSupertest.post('/api/user/register')
      .send({
        username: userId,
        password: 'password',
        callsign: 1
      });
    expect(res.status).toEqual(500);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', ['\'callsign\' must be of type \'string\'!']);
  });

  it('POST /api/user/register should reject a request with a non-string for theme', async () => {
    const res = await requestWithSupertest.post('/api/user/register')
      .send({
        username: userId,
        password: 'password',
        callsign: 'sample2@gmail.com',
        theme: 1
      });
    expect(res.status).toEqual(500);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', ['\'theme\' must be of type \'string\'!']);
  });

  it('POST /api/user/register should reject a request with af non-string for role', async () => {
    const res = await requestWithSupertest.post('/api/user/register')
      .send({
        username: userId,
        password: 'password',
        callsign: 'sample@gmail.com',
        role: 1
      });
    expect(res.status).toEqual(500);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', ['\'role\' must be of type \'string\'!']);
  });
  
});