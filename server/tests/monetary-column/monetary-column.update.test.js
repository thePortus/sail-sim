const app = require('../../app.js');
const supertest = require('supertest');
const requestWithSupertest = supertest(app);

describe('MonetaryColumn Update Endpoints', () => {

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

  beforeEach(async () => {
    const res = await requestWithSupertest
      .post('/api/monetary-columns')
      .set('Authorization', `${ownerToken}`)
      .send({
        title: 'Test MonetaryColumn',
        notes: ''
      });
    createdId = res.body.id;
  });

  afterEach(async () => {
    await requestWithSupertest
      .delete(`/api/monetary-columns/${createdId}`)
      .set('Authorization', `${ownerToken}`);
  });

  it('UPDATE /api/monetary-columns/:id should update a single monetary-column from an owner', async () => {
    const res = await requestWithSupertest.put('/api/monetary-columns/' + createdId.toString())
      .set('Authorization', `${ownerToken}`)
      .send({
        id: createdId,
        title: 'Updated Test'
      });
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', 'MonetaryColumn was updated successfully.');
  });

  it('UPDATE /api/monetary-columns/:id should update a single monetary-column from an admin', async () => {
    const res = await requestWithSupertest.put('/api/monetary-columns/' + createdId.toString())
      .set('Authorization', `${adminToken}`)
      .send({
        id: createdId,
        title: 'Updated Test'
      });
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', 'MonetaryColumn was updated successfully.');
  });

  it('UPDATE /api/monetary-columns/:id should request a request from an editor', async () => {
    const res = await requestWithSupertest.put('/api/monetary-columns/' + createdId.toString())
      .set('Authorization', `${editorToken}`)
      .send({
        id: createdId,
        title: 'Updated Test'
      });
    expect(res.status).toEqual(401);
  });

  it('UPDATE /api/monetary-columns/:id should reject request without proper authorization', async () => {
    const res = await requestWithSupertest.put('/api/monetary-columns/' + createdId.toString())
      .send({
        id: createdId,
        title: 'Updated Test'
      });
    expect(res.status).toEqual(401);
  });

  it('UPDATE /api/monetary-columns/:id should reject request from regular users with no privileges', async () => {
    const res = await requestWithSupertest.put('/api/monetary-columns/' + createdId.toString())
      .set('Authorization', `${userToken}`)
      .send({
        id: createdId,
        title: 'Updated Test'
      });
    expect(res.status).toEqual(401);
  });

  it('UPDATE /api/monetary-columns/:id should reject request for unknown item', async () => {
    const res = await requestWithSupertest.put('/api/monetary-columns/9999')
      .set('Authorization', `${ownerToken}`)
      .send({
        id: '9999',
        title: 'Updated Test'
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', 'Cannot update monetaryColumn with id=9999. Maybe monetaryColumn was not found!');
  });

  it('UPDATE /api/monetary-columns should reject items with titles that are not strings', async () => {
    const res = await requestWithSupertest
      .put('/api/monetary-columns/' + createdId.toString())
      .set('Authorization', `${ownerToken}`)
      .send({
        title: 123,
        notes: ''
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['\'title\' must be of type \'string\'!']);
  });

  it('UPDATE /api/monetary-columns should reject items with notes that are not strings', async () => {
    const res = await requestWithSupertest
      .put('/api/monetary-columns/' + createdId.toString())
      .set('Authorization', `${ownerToken}`)
      .send({
        title: 'Test',
        notes: 123
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['\'notes\' must be of type \'string\'!']);
  });

  it('UPDATE /api/monetary-columns/:id should log a change', async () => {
    await requestWithSupertest.put('/api/monetary-columns/' + createdId.toString())
      .set('Authorization', `${ownerToken}`)
      .send({
        title: 'Testing'
      });
    const changeRes = await requestWithSupertest
      .get(`/api/changes?page=0&size=5&table=MonetaryColumns&action=Update&itemId=${createdId}`)
      .set('Authorization', `${ownerToken}`);
    expect(changeRes.status).toEqual(200);
    expect(changeRes.type).toEqual(expect.stringContaining('json'));
    expect(changeRes.body.rows.length).toBeGreaterThanOrEqual(1);
  });

});