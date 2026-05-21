const app = require('../../app.js');
const supertest = require('supertest');
const requestWithSupertest = supertest(app);

describe('User Endpoints', () => {

  let ownerToken = '';
  let adminToken = '';
  let editorToken = '';
  let userToken = '';
  let userId = 'TestingUser';

  beforeAll(async () => {
    const ownerResponse = await supertest(app).post('/api/user/login')
      .send({
        username: process.env.OWNER_USERNAME || 'jesuit-catalogs-owner',
        password: process.env.OWNER_PASSWORD || 'password'
      });
    ownerToken = ownerResponse.body.token;
    const adminResponse = await supertest(app).post('/api/user/login')
      .send({
        username: 'testAdmin',
        password: 'password'
      });
    adminToken = adminResponse.body.token;
    const editorResponse = await supertest(app).post('/api/user/login')
      .send({
        username: 'testEditor',
        password: 'password'
      });
    editorToken = editorResponse.body.token;
    const userResponse = await supertest(app).post('/api/user/login')
      .send({
        username: 'testUser',
        password: 'password'
      });
    userToken = userResponse.body.token;
    const res = await requestWithSupertest.post('/api/user/register')
      .send({
        username: userId,
        password: 'password',
        email: 'sample@gmail.com'
      });
  });

  afterAll(async () => {
    await requestWithSupertest.delete(`/api/user/delete/${userId}`)
      .set('Authorization', `${ownerToken}`);
  });

  it('GET /api/user should show all users', async () => {
    const res = await requestWithSupertest.get('/api/user')
      .set('Authorization', `${ownerToken}`);
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/user?page=1&size=5 should show paginated users', async () => {
    const res = await requestWithSupertest.get('/api/user?page=0&size=5')
      .set('Authorization', `${ownerToken}`);
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.rows.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/user?page=1&size=5&title=xyzzyx should filter by username', async () => {
    const res = await requestWithSupertest.get('/api/user?page=0&size=5&username=xyzzyx')
      .set('Authorization', `${ownerToken}`);
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body.rows.length).toBe(0);
  });

  it('GET /api/user should reject request without proper authorization', async () => {
    const res = await requestWithSupertest.get('/api/user');
    expect(res.status).toEqual(401);
  });

  it('GET /api/user/profile should show all profile data', async () => {
    const requestString = process.env.OWNER_USERNAME !== undefined ? process.env.OWNER_USERNAME : 'jesuit-catalogs-owner';
    const res = await requestWithSupertest.get('/api/user/profile/' + requestString)
      .set('Authorization', `${ownerToken}`);
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('data');
  });

  it('GET /api/user/profile should reject an unknown user', async () => {
    const requestString = 'SomeUnknownUserXYZ';
    const res = await requestWithSupertest.get('/api/user/profile/' + requestString)
      .set('Authorization', `${ownerToken}`);
    expect(res.status).toEqual(500);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', 'User not found.');
  });

  it('GET /api/user/profile should reject a request without proper authorization', async () => {
    const requestString = process.env.OWNER_USERNAME !== undefined ? process.env.OWNER_USERNAME : 'jesuit-catalogs-owner';
    const res = await requestWithSupertest.get('/api/user/profile/' + requestString);
    expect(res.status).toEqual(401);
  });
  
});