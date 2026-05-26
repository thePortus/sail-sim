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
  });

  beforeEach(async () => {
    const res = await requestWithSupertest.post('/api/user/register')
      .send({
        username: userId,
        password: 'password',
        callsign: 'sample@gmail.com'
      });
  });

  afterEach(async () => {
    await requestWithSupertest.delete(`/api/user/delete/${userId}`)
      .set('Authorization', `${ownerToken}`);
  });

  it('PUT /api/user/update/:username should update a user\'s callsign', async () => {
    const res = await requestWithSupertest.put(`/api/user/update/${userId}`)
      .set('Authorization', `${ownerToken}`)
      .send({
        callsign: 'updated_sample@gmail.com'
      });
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', 'User was updated successfully.');
  });

  it('PUT /api/user/update/:username should update a user\'s role', async () => {
    const res = await requestWithSupertest.put(`/api/user/update/${userId}`)
      .set('Authorization', `${ownerToken}`)
      .send({
        role: 'Editor'
      });
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', 'User was updated successfully.');
  });

  it('PUT /api/user/update/:username should reject updating a role without proper authorization', async () => {
    const res = await requestWithSupertest.put(`/api/user/update/${userId}`)
      .send({
        role: 'Editor'
      });
    expect(res.status).toEqual(401);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', 'Unauthorized');
  });

  it('PUT /api/user/update/:username should update a user\'s theme', async () => {
    const res = await requestWithSupertest.put(`/api/user/update/${userId}`)
      .set('Authorization', `${ownerToken}`)
      .send({
        theme: 'dark'
      });
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', 'User was updated successfully.');
  });

  it('PUT /api/user/:username should reject a request with a non-string for username', async () => {
    const res = await requestWithSupertest.put(`/api/user/update/${userId}`)
      .set('Authorization', `${ownerToken}`)
      .send({
        username: 1,
      });
    expect(res.status).toEqual(500);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', ['\'username\' must be of type \'string\'!']);
  });

  it('PUT /api/user/:username should reject a request with a non-string for password', async () => {
    const res = await requestWithSupertest.put(`/api/user/update/${userId}`)
      .set('Authorization', `${ownerToken}`)
      .send({
        password: 1,
      });
    expect(res.status).toEqual(500);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', ['\'password\' must be of type \'string\'!']);
  });

  it('PUT /api/user/:username should reject a request with a non-string for callsign', async () => {
    const res = await requestWithSupertest.put(`/api/user/update/${userId}`)
      .set('Authorization', `${ownerToken}`)
      .send({
        callsign: 1,
      });
    expect(res.status).toEqual(500);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', ['\'callsign\' must be of type \'string\'!']);
  });

  it('PUT /api/user/:username should reject a request with a non-string for theme', async () => {
    const res = await requestWithSupertest.put(`/api/user/update/${userId}`)
      .set('Authorization', `${ownerToken}`)
      .send({
        theme: 1,
      });
    expect(res.status).toEqual(500);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', ['\'theme\' must be of type \'string\'!']);
  });

  it('PUT /api/user/:username should reject a request with a non-string for role', async () => {
    const res = await requestWithSupertest.put(`/api/user/update/${userId}`)
      .set('Authorization', `${ownerToken}`)
      .send({
        role: 1,
      });
    expect(res.status).toEqual(500);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', ['\'role\' must be of type \'string\'!']);
  });

  it('PUT /api/user/update/:username should reject updating an unknown user', async () => {
    const res = await requestWithSupertest.put(`/api/user/update/${userId}XYZZYX`)
      .set('Authorization', `${ownerToken}`)
      .send({
        theme: 'dark'
      });
    expect(res.status).toEqual(500);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', 'Cannot update User with username=TestingUserXYZZYX. Maybe User was not found!');
  });

  it('PUT /api/user/update/:username should reject updating to an invalid role', async () => {
    const res = await requestWithSupertest.put(`/api/user/update/${userId}`)
      .set('Authorization', `${ownerToken}`)
      .send({
        role: 'Code Tester'
      });
    expect(res.status).toEqual(401);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', 'User is unauthorized to change to the desired role level or password (or the role level was invalid).');
  });

  it('PUT /api/user/:username should reject unauthorized request', async () => {
    const res = await requestWithSupertest.put(`/api/user/update/${userId}`)
      .send({
        callsign: 'updated_sample@gmail.com'
      });
    expect(res.status).toEqual(401);
    expect(res.type).toEqual(expect.stringContaining('json'));
  });

  it('PUT /api/user/:username should accept role update to owner from owner', async () => {
    const res = await requestWithSupertest.put(`/api/user/update/${userId}`)
      .set('Authorization', `${ownerToken}`)
      .send({
        role: 'Owner'
      });
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', 'User was updated successfully.');
  });

  it('PUT /api/user/:username should reject role update to owner from users', async () => {
    const res = await requestWithSupertest.put(`/api/user/update/${userId}`)
      .set('Authorization', `${userToken}`)
      .send({
        role: 'Owner'
      });
    expect(res.status).toEqual(401);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', 'User is unauthorized to change to the desired role level or password (or the role level was invalid).');
  });

  it('PUT /api/user/:username should reject role update to owner from editors', async () => {
    const res = await requestWithSupertest.put(`/api/user/update/${userId}`)
      .set('Authorization', `${editorToken}`)
      .send({
        role: 'Owner'
      });
    expect(res.status).toEqual(401);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', 'User is unauthorized to change to the desired role level or password (or the role level was invalid).');
  });

  it('PUT /api/user/:username should reject role update to owner from admins', async () => {
    const res = await requestWithSupertest.put(`/api/user/update/${userId}`)
      .set('Authorization', `${adminToken}`)
      .send({
        role: 'Owner'
      });
    expect(res.status).toEqual(401);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', 'User is unauthorized to change to the desired role level or password (or the role level was invalid).');
  });

  it('PUT /api/user/:username should accept role update to admin from owner', async () => {
    const res = await requestWithSupertest.put(`/api/user/update/${userId}`)
      .set('Authorization', `${ownerToken}`)
      .send({
        role: 'Admin'
      });
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', 'User was updated successfully.');
  });

  it('PUT /api/user/:username should reject role update to admin from admins', async () => {
    const res = await requestWithSupertest.put(`/api/user/update/${userId}`)
      .set('Authorization', `${adminToken}`)
      .send({
        role: 'Admin'
      });
    expect(res.status).toEqual(401);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', 'User is unauthorized to change to the desired role level or password (or the role level was invalid).');
  });

  it('PUT /api/user/:username should reject role update to admin from editors', async () => {
    const res = await requestWithSupertest.put(`/api/user/update/${userId}`)
      .set('Authorization', `${editorToken}`)
      .send({
        role: 'Admin'
      });
    expect(res.status).toEqual(401);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', 'User is unauthorized to change to the desired role level or password (or the role level was invalid).');
  });

  it('PUT /api/user/:username should reject role update to admin from users', async () => {
    const res = await requestWithSupertest.put(`/api/user/update/${userId}`)
      .set('Authorization', `${userToken}`)
      .send({
        role: 'Admin'
      });
    expect(res.status).toEqual(401);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', 'User is unauthorized to change to the desired role level or password (or the role level was invalid).');
  });

  it('PUT /api/user/:username should accept role update to editor from owner', async () => {
    const res = await requestWithSupertest.put(`/api/user/update/${userId}`)
      .set('Authorization', `${ownerToken}`)
      .send({
        role: 'Editor'
      });
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', 'User was updated successfully.');
  });

  it('PUT /api/user/:username should accept role update to editor from admin', async () => {
    const res = await requestWithSupertest.put(`/api/user/update/${userId}`)
      .set('Authorization', `${adminToken}`)
      .send({
        role: 'Editor'
      });
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', 'User was updated successfully.');
  });

  it('PUT /api/user/:username should reject role update to editor from editors', async () => {
    const res = await requestWithSupertest.put(`/api/user/update/${userId}`)
      .set('Authorization', `${editorToken}`)
      .send({
        role: 'Editor'
      });
    expect(res.status).toEqual(401);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', 'User is unauthorized to change to the desired role level or password (or the role level was invalid).');
  });

  it('PUT /api/user/:username should reject role update to editor from users', async () => {
    const res = await requestWithSupertest.put(`/api/user/update/${userId}`)
      .set('Authorization', `${userToken}`)
      .send({
        role: 'Editor'
      });
    expect(res.status).toEqual(401);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', 'User is unauthorized to change to the desired role level or password (or the role level was invalid).');
  });
  
});