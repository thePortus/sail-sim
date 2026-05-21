const { create } = require('archiver');
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

  afterEach(async () => {
    await requestWithSupertest
      .delete(`/api/communities/${createdId}`)
      .set('Authorization', `${ownerToken}`);
  });

  it('CREATE /api/communities should accept valid data from an owner', async () => {
    const res = await requestWithSupertest
      .post('/api/communities')
      .set('Authorization', `${ownerToken}`)
      .send({
        title: 'Test',
        type: 'Test',
        description: 'Test',
        notes: ''
      });
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('title');
    expect(res.body).toHaveProperty('type');
    expect(res.body).toHaveProperty('description');
    expect(res.body).toHaveProperty('notes');
    createdId = res.body.id;
  });

  it('CREATE /api/communities should accept valid data from an admin', async () => {
    const res = await requestWithSupertest
      .post('/api/communities')
      .set('Authorization', `${adminToken}`)
      .send({
        title: 'Test',
        type: 'Test',
        description: 'Test',
        notes: ''
      });
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('title');
    expect(res.body).toHaveProperty('type');
    expect(res.body).toHaveProperty('description');
    expect(res.body).toHaveProperty('notes');
    createdId = res.body.id;
  });

  it('CREATE /api/communities should accept valid data from an editor', async () => {
    const res = await requestWithSupertest
      .post('/api/communities')
      .set('Authorization', `${editorToken}`)
      .send({
        title: 'Test',
        type: 'Test',
        description: 'Test',
        notes: ''
      });
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('title');
    expect(res.body).toHaveProperty('type');
    expect(res.body).toHaveProperty('description');
    expect(res.body).toHaveProperty('notes');
    createdId = res.body.id;
  });

  it('CREATE /api/communities should reject request without proper authorization', async () => {
    const res = await requestWithSupertest
      .post('/api/communities')
      .send({
        title: 'Test',
        type: 'Test',
        description: 'Test',
        notes: ''
      });
    expect(res.status).toEqual(401);
  });

  it('CREATE /api/communities should reject request from regular users with no privileges', async () => {
    const res = await requestWithSupertest
      .post('/api/communities')
      .set('Authorization', `${userToken}`)
      .send({
        title: 'Test',
        type: 'Test',
        description: 'Test',
        notes: ''
      });
    expect(res.status).toEqual(401);
  });

  it('CREATE /api/communities should reject items without title', async () => {
    const res = await requestWithSupertest
      .post('/api/communities')
      .set('Authorization', `${ownerToken}`)
      .send({
        type: 'Test',
        description: 'Test',
        notes: ''
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['Must contain a \'title\' field!']);
  });

  it('CREATE /api/communities should reject items with titles that are not strings', async () => {
    const res = await requestWithSupertest
      .post('/api/communities')
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

  it('CREATE /api/communities should reject items without type', async () => {
    const res = await requestWithSupertest
      .post('/api/communities')
      .set('Authorization', `${ownerToken}`)
      .send({
        title: 'Test',
        description: 'Test',
        notes: ''
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['Must contain a \'type\' field!']);
  });

  it('CREATE /api/communities should reject items with types that are not strings', async () => {
    const res = await requestWithSupertest
      .post('/api/communities')
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

  it('CREATE /api/communities should reject items with descriptions that are not strings', async () => {
    const res = await requestWithSupertest
      .post('/api/communities')
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

  it('CREATE /api/communities should reject items with notes that are not strings', async () => {
    const res = await requestWithSupertest
      .post('/api/communities')
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

  // test for change logs
  it('CREATE /api/communities should log a change', async () => {
    const itemRes = await requestWithSupertest
      .post('/api/communities')
      .set('Authorization', `${ownerToken}`)
      .send({
        title: 'Test',
        type: 'Test',
        description: 'Test',
        notes: ''
      });
    const changeRes = await requestWithSupertest
      .get(`/api/changes?page=0&size=5&table=Communities&action=Create&itemId=${itemRes.body.id}`)
      .set('Authorization', `${ownerToken}`);
    expect(changeRes.status).toEqual(200);
    expect(changeRes.type).toEqual(expect.stringContaining('json'));
    expect(changeRes.body.rows.length).toBeGreaterThanOrEqual(1);
    createdId = itemRes.body.id;
  });

});