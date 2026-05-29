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
        username: process.env.OWNER_USERNAME || 'sail-sim-owner',
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
  });

  beforeEach(async () => {
    const res = await requestWithSupertest.post('/api/user/register')
      .send({
        username: userId,
        password: 'password',
        callsign: userId
      });
    userId = res.body.data.username;
  });

  afterEach(async () => {
    await requestWithSupertest.delete(`/api/user/delete/${userId}`)
      .set('Authorization', `${ownerToken}`);
  });

  it('DELETE /api/user/:id should delete a user with proper authorization', async () => {
    // Delete the test user
    const res = await requestWithSupertest.delete(`/api/user/delete/${userId}`)
      .set('Authorization', `${ownerToken}`);
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', 'User was deleted successfully.');
  });

  it('DELETE /api/user/:id should reject a delete request without proper authorization', async () => {
    // Attempt to delete the test user without authorization
    const deleteUserRes = await requestWithSupertest.delete(`/api/user/delete/${userId}`);
    expect(deleteUserRes.status).toEqual(401);
  });

  it('DELETE /api/user/:id should reject a delete request from user', async () => {
    // Attempt to delete the test user without authorization
    const res = await requestWithSupertest.delete(`/api/user/delete/${userId}`)
      .set('Authorization', `${userToken}`);
    expect(res.status).toEqual(401);
    expect(res.body).toHaveProperty('message', 'User is not an approved administrator');
  });

  it('DELETE /api/user/:id should reject a delete request from editor', async () => {
    // Attempt to delete the test user without authorization
    const res = await requestWithSupertest.delete(`/api/user/delete/${userId}`)
      .set('Authorization', `${editorToken}`);
    expect(res.status).toEqual(401);
    expect(res.body).toHaveProperty('message', 'User is not an approved administrator');
  });
  
});