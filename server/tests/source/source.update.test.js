const app = require('../../app.js');
const supertest = require('supertest');
const requestWithSupertest = supertest(app);

describe('Source Endpoints', () => {

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
      .post('/api/sources')
      .set('Authorization', `${ownerToken}`)
      .send({
        idBox: '12345',
        archive: 'Test Archive',
        volume: 'Test Volume',
        page: '4v',
        url: 'https://www.test.com',
        notes: ''
      });
    createdId = res.body.id;
  });

  afterEach(async () => {
    await requestWithSupertest
      .delete(`/api/sources/${createdId}`)
      .set('Authorization', `${ownerToken}`);
  });

  it('UPDATE /api/sources/:id should update a single source from an owner', async () => {
    const res = await requestWithSupertest.put('/api/sources/' + createdId.toString())
      .set('Authorization', `${ownerToken}`)
      .send({
        archive: 'Updated Test'
      });
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', 'Source was updated successfully.');
  });

  it('UPDATE /api/sources/:id should update a single source from an admin', async () => {
    const res = await requestWithSupertest.put('/api/sources/' + createdId.toString())
      .set('Authorization', `${adminToken}`)
      .send({
        archive: 'Updated Test'
      });
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', 'Source was updated successfully.');
  });

  it('UPDATE /api/sources/:id should request a request from an editor', async () => {
    const res = await requestWithSupertest.put('/api/sources/' + createdId.toString())
      .set('Authorization', `${editorToken}`)
      .send({
        archive: 'Updated Test'
      });
    expect(res.status).toEqual(401);
  });

  it('UPDATE /api/sources/:id should reject request without proper authorization', async () => {
    const res = await requestWithSupertest.put('/api/sources/' + createdId.toString())
      .send({
        archive: 'Updated Test'
      });
    expect(res.status).toEqual(401);
  });

  it('UPDATE /api/sources/:id should reject request from regular users with no privileges', async () => {
    const res = await requestWithSupertest.put('/api/sources/' + createdId.toString())
      .set('Authorization', `${userToken}`)
      .send({
        archive: 'Updated Test'
      });
    expect(res.status).toEqual(401);
  });

  it('UPDATE /api/sources/:id should reject request for unknown item', async () => {
    const res = await requestWithSupertest.put('/api/sources/9999')
      .set('Authorization', `${ownerToken}`)
      .send({
        archive: 'Updated Test'
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', 'Cannot update source with id=9999. Maybe source was not found!');
  });

  it('UPDATE /api/sources should reject items with volumes that are not strings', async () => {
    const res = await requestWithSupertest
      .put('/api/sources/' + createdId.toString())
      .set('Authorization', `${ownerToken}`)
      .send({
        volume: 123,
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['\'volume\' must be of type \'string\'!']);
  });

  it('UPDATE /api/sources should reject items with pages that are not strings', async () => {
    const res = await requestWithSupertest
      .put('/api/sources/' + createdId.toString())
      .set('Authorization', `${ownerToken}`)
      .send({
        page: 123,
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['\'page\' must be of type \'string\'!']);
  });

  it('UPDATE /api/sources should reject items with urls that are not strings', async () => {
    const res = await requestWithSupertest
      .put('/api/sources/' + createdId.toString())
      .set('Authorization', `${ownerToken}`)
      .send({
        url: 123,
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['\'url\' must be of type \'string\'!']);
  });

  it('UPDATE /api/sources should reject items with notes that are not strings', async () => {
    const res = await requestWithSupertest
      .put('/api/sources/' + createdId.toString())
      .set('Authorization', `${ownerToken}`)
      .send({
        notes: 123
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['\'notes\' must be of type \'string\'!']);
  });

  it('UPDATE /api/sources/:id should log a change', async () => {
    await requestWithSupertest.put('/api/sources/' + createdId.toString())
      .set('Authorization', `${ownerToken}`)
      .send({
        archive: 'Testing'
      });
    const changeRes = await requestWithSupertest
      .get(`/api/changes?page=0&size=5&table=Sources&action=Update&itemId=${createdId}`)
      .set('Authorization', `${ownerToken}`);
    expect(changeRes.status).toEqual(200);
    expect(changeRes.type).toEqual(expect.stringContaining('json'));
    expect(changeRes.body.rows.length).toBeGreaterThanOrEqual(1);
  });

});