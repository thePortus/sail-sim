const app = require('../../app.js');
const supertest = require('supertest');
const requestWithSupertest = supertest(app);

describe('Community Endpoints', () => {

  let ownerToken = '';
  let adminToken = '';
  let editorToken = '';
  let userToken = '';
  let createdId = '';

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
    const res = await requestWithSupertest
      .post('/api/communities')
      .set('Authorization', `${ownerToken}`)
      .send({
        title: 'Test',
        type: 'Test',
        description: 'Test',
        notes: ''
      });
    createdId = res.body.id;
  });

  afterEach(async () => {
    await requestWithSupertest
      .delete(`/api/communities/${createdId}`)
      .set('Authorization', `${ownerToken}`);
  });

  it('UPDATE /api/communities/:id should update a single community from an owner', async () => {
    const res = await requestWithSupertest.put('/api/communities/' + createdId.toString())
      .set('Authorization', `${ownerToken}`)
      .send({
        id: createdId,
        title: 'Updated Test',
        type: 'Updated Test',
      });
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', 'Community was updated successfully.');
  });

  it('UPDATE /api/communities/:id should update a single community from an admin', async () => {
    const res = await requestWithSupertest.put('/api/communities/' + createdId.toString())
      .set('Authorization', `${adminToken}`)
      .send({
        title: 'Updated Test',
        type: 'Updated Test',
      });
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', 'Community was updated successfully.');
  });

  it('UPDATE /api/communities/:id should update a single community from an editor', async () => {
    const res = await requestWithSupertest.put('/api/communities/' + createdId.toString())
      .set('Authorization', `${editorToken}`)
      .send({
        title: 'Updated Test',
        type: 'Updated Test',
      });
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', 'Community was updated successfully.');
  });

  it('UPDATE /api/communities/:id should reject request without proper authorization', async () => {
    const res = await requestWithSupertest.put('/api/communities/' + createdId.toString())
      .send({
        title: 'Updated Test',
        type: 'Updated Test',
      });
    expect(res.status).toEqual(401);
  });

  it('UPDATE /api/communities/:id should reject request from regular users with no privileges', async () => {
    const res = await requestWithSupertest.put('/api/communities/' + createdId.toString())
      .set('Authorization', `${userToken}`)
      .send({
        id: createdId,
        title: 'Updated Test',
        type: 'Updated Test',
      });
    expect(res.status).toEqual(401);
  });

  it('UPDATE /api/communities/:id should reject request for unknown item', async () => {
    const res = await requestWithSupertest.put('/api/communities/9999')
      .set('Authorization', `${ownerToken}`)
      .send({
        id: '9999',
        title: 'Updated Test',
        type: 'Updated Test',
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', 'Cannot update community with id=9999. Maybe community was not found!');
  });

  it('UPDATE /api/communities should reject items with titles that are not strings', async () => {
    const res = await requestWithSupertest
      .put('/api/communities/' + createdId.toString())
      .set('Authorization', `${ownerToken}`)
      .send({
        title: 123,
        type: 'Test',
        description: 'Test',
        notes: ''
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['\'title\' must be of type \'string\'!']);
  });

  it('UPDATE /api/communities should reject items with types that are not strings', async () => {
    const res = await requestWithSupertest
      .put('/api/communities/' + createdId.toString())
      .set('Authorization', `${ownerToken}`)
      .send({
        title: 'Test',
        type: 123,
        description: 'Test',
        notes: ''
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['\'type\' must be of type \'string\'!']);
  });

  it('UPDATE /api/communities should reject items with descriptions that are not strings', async () => {
    const res = await requestWithSupertest
      .put('/api/communities/' + createdId.toString())
      .set('Authorization', `${ownerToken}`)
      .send({
        title: 'Test',
        type: 'Test',
        description: 123,
        notes: ''
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['\'description\' must be of type \'string\'!']);
  });

  it('UPDATE /api/communities should reject items with notes that are not strings', async () => {
    const res = await requestWithSupertest
      .put('/api/communities/' + createdId.toString())
      .set('Authorization', `${ownerToken}`)
      .send({
        title: 'Test',
        type: 'Test',
        description: 'Test',
        notes: 123
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['\'notes\' must be of type \'string\'!']);
  });

  it('UPDATE /api/communities/:id should log a change', async () => {
    await requestWithSupertest.put('/api/communities/' + createdId.toString())
      .set('Authorization', `${ownerToken}`)
      .send({
        id: createdId,
        title: 'Updated Test',
        type: 'Updated Test',
      });
    const changeRes = await requestWithSupertest
      .get(`/api/changes?page=0&size=5&table=Communities&action=Update&itemId=${createdId}`)
      .set('Authorization', `${ownerToken}`);
    expect(changeRes.status).toEqual(200);
    expect(changeRes.type).toEqual(expect.stringContaining('json'));
    expect(changeRes.body.rows.length).toBeGreaterThanOrEqual(1);
  });

});