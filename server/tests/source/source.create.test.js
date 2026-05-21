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

  afterEach(async () => {
    const res = await requestWithSupertest
      .delete(`/api/sources/${createdId}`)
      .set('Authorization', `${ownerToken}`);
  });

  it('CREATE /api/sources should accept valid data from an owner', async () => {
    const res = await requestWithSupertest
      .post('/api/sources')
      .set('Authorization', `${ownerToken}`)
      .send({
        volume: 'Test Volume',
        page: '4v',
        idBox: '12345',
        archive: 'Test Archive',
        url: 'https://www.test.com',
        notes: ''
      });
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('volume');
    expect(res.body).toHaveProperty('page');
    expect(res.body).toHaveProperty('url');
    expect(res.body).toHaveProperty('notes');
    createdId = res.body.id;
  });
  
  it('CREATE /api/sources should accept valid data from an admin', async () => {
    const res = await requestWithSupertest
      .post('/api/sources')
      .set('Authorization', `${adminToken}`)
      .send({
        volume: 'Test Volume',
        page: '4v',
        idBox: '12345',
        archive: 'Test Archive',
        url: 'https://www.test.com',
        notes: ''
      });
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('volume');
    expect(res.body).toHaveProperty('page');
    expect(res.body).toHaveProperty('url');
    expect(res.body).toHaveProperty('notes');
    createdId = res.body.id;
  });

  it('CREATE /api/sources should reject request from editor', async () => {
    const res = await requestWithSupertest
      .post('/api/sources')
      .set('Authorization', `${editorToken}`)
      .send({
        volume: 'Test Volume',
        page: '4v',
        url: 'https://www.test.com',
        idBox: '12345',
        archive: 'Test Archive',
        notes: ''
      });
    expect(res.status).toEqual(401);
    createdId = res.body.id;
  });

  it('CREATE /api/sources should reject request without proper authorization', async () => {
    const res = await requestWithSupertest
      .post('/api/sources')
      .send({
        volume: 'Test Volume',
        page: '4v',
        url: 'https://www.test.com',
        idBox: '12345',
        archive: 'Test Archive',
        notes: ''
      });
    expect(res.status).toEqual(401);
    createdId = res.body.id;
  });

  it('CREATE /api/sources should reject request from regular users with no privileges', async () => {
    const res = await requestWithSupertest
      .post('/api/sources')
      .set('Authorization', `${userToken}`)
      .send({
        volume: 'Test Volume',
        page: '4v',
        url: 'https://www.test.com',
        idBox: '12345',
        archive: 'Test Archive',
        notes: ''
      });
    expect(res.status).toEqual(401);
    createdId = res.body.id;
  });

  it('CREATE /api/sources should reject items with volumes that are not strings', async () => {
    const res = await requestWithSupertest
      .post('/api/sources')
      .set('Authorization', `${ownerToken}`)
      .send({
        volume: 123,
        idBox: '12345',
        archive: 'Test Archive',
        notes: ''
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['\'volume\' must be of type \'string\'!']);
    createdId = res.body.id;
  });

  it('CREATE /api/sources should reject items with pages that are not strings', async () => {
    const res = await requestWithSupertest
      .post('/api/sources')
      .set('Authorization', `${ownerToken}`)
      .send({
        page: 123,
        idBox: '12345',
        archive: 'Test Archive',
        notes: ''
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['\'page\' must be of type \'string\'!']);
    createdId = res.body.id;
  });

  it('CREATE /api/sources should reject items with urls that are not strings', async () => {
    const res = await requestWithSupertest
      .post('/api/sources')
      .set('Authorization', `${ownerToken}`)
      .send({
        url: 123,
        idBox: '12345',
        archive: 'Test Archive',
        notes: ''
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['\'url\' must be of type \'string\'!']);
    createdId = res.body.id;
  });

  it('CREATE /api/sources should reject items with idBoxes that are not strings', async () => {
    const res = await requestWithSupertest
      .post('/api/sources')
      .set('Authorization', `${ownerToken}`)
      .send({
        url: '123',
        idBox: 12345,
        archive: 'Test Archive',
        notes: ''
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['\'idBox\' must be of type \'string\'!']);
    createdId = res.body.id;
  });

  it('CREATE /api/sources should reject items with archives that are not strings', async () => {
    const res = await requestWithSupertest
      .post('/api/sources')
      .set('Authorization', `${ownerToken}`)
      .send({
        url: '123',
        idBox: '12345',
        archive: 12345,
        notes: ''
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['\'archive\' must be of type \'string\'!']);
    createdId = res.body.id;
  });

  it('CREATE /api/sources should reject items with notes that are not strings', async () => {
    const res = await requestWithSupertest
      .post('/api/sources')
      .set('Authorization', `${ownerToken}`)
      .send({
        idBox: '12345',
        archive: 'Test Archive',
        notes: 123
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['\'notes\' must be of type \'string\'!']);
    createdId = res.body.id;
  });

  // test for change logs
  it('CREATE /api/sources should log a change', async () => {
    const itemRes = await requestWithSupertest
      .post('/api/sources')
      .set('Authorization', `${ownerToken}`)
      .send({
        volume: 'Test Volume',
        page: '4v',
        idBox: '12345',
        archive: 'Test Archive',
        url: 'https://www.test.com',
        notes: ''
      });
    const changeRes = await requestWithSupertest
      .get(`/api/changes?page=0&size=5&table=Sources&action=Create&itemId=${itemRes.body.id}`)
      .set('Authorization', `${ownerToken}`);
    expect(changeRes.status).toEqual(200);
    expect(changeRes.type).toEqual(expect.stringContaining('json'));
    expect(changeRes.body.rows.length).toBeGreaterThanOrEqual(1);

    createdId = itemRes.body.id;
  });
});