const { create } = require('archiver');
const app = require('../../app.js');
const supertest = require('supertest');
const requestWithSupertest = supertest(app);

describe('Community Location Endpoints', () => {

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
      .delete(`/api/community-locations/${createdId}`)
      .set('Authorization', `${ownerToken}`);
  });

  it('CREATE /api/community-location should accept valid data from owner', async () => {
    const res = await requestWithSupertest
      .post('/api/community-locations')
      .set('Authorization', `${ownerToken}`)
      .send({
        title: 'Test',
        assistancy: 'Test',
        province: 'Test',
        city: 'Test',
        latitude: 1,
        longitude: 1,
        isPrecise: true,
        notes: ''
      });
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('title');
    expect(res.body).toHaveProperty('assistancy');
    expect(res.body).toHaveProperty('province');
    expect(res.body).toHaveProperty('city');
    expect(res.body).toHaveProperty('latitude');
    expect(res.body).toHaveProperty('longitude');
    expect(res.body).toHaveProperty('isPrecise');
    expect(res.body).toHaveProperty('notes');
    createdId = res.body.id;
  });

  it('CREATE /api/community-location should accept valid data from admin', async () => {
    const res = await requestWithSupertest
      .post('/api/community-locations')
      .set('Authorization', `${adminToken}`)
      .send({
        title: 'Test',
        assistancy: 'Test',
        province: 'Test',
        city: 'Test',
        latitude: 1,
        longitude: 1,
        isPrecise: true,
        notes: ''
      });
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('title');
    expect(res.body).toHaveProperty('assistancy');
    expect(res.body).toHaveProperty('province');
    expect(res.body).toHaveProperty('city');
    expect(res.body).toHaveProperty('latitude');
    expect(res.body).toHaveProperty('longitude');
    expect(res.body).toHaveProperty('isPrecise');
    expect(res.body).toHaveProperty('notes');
    createdId = res.body.id;
  });

  it('CREATE /api/community-locations should reject request without proper authorization', async () => {
    const res = await requestWithSupertest
      .post('/api/community-locations')
      .send({
        title: 'Test',
        assistancy: 'Test',
        province: 'Test',
        city: 'Test',
        latitude: 1,
        longitude: 1,
        isPrecise: true,
        notes: ''
      });
    expect(res.status).toEqual(401);
  });

  it('CREATE /api/community-locations should reject request from editors', async () => {
    const res = await requestWithSupertest
      .post('/api/community-locations')
      .set('Authorization', `${editorToken}`)
      .send({
        title: 'Test',
        assistancy: 'Test',
        province: 'Test',
        city: 'Test',
        latitude: 1,
        longitude: 1,
        isPrecise: true,
        notes: ''
      });
    expect(res.status).toEqual(401);
  });

  it('CREATE /api/community-locations should reject request from regular users without privileges', async () => {
    const res = await requestWithSupertest
      .post('/api/community-locations')
      .set('Authorization', `${userToken}`)
      .send({
        title: 'Test',
        assistancy: 'Test',
        province: 'Test',
        city: 'Test',
        latitude: 1,
        longitude: 1,
        isPrecise: true,
        notes: ''
      });
    expect(res.status).toEqual(401);
  });

  it('CREATE /api/community-locations should reject items without latitude', async () => {
    const res = await requestWithSupertest
      .post('/api/community-locations')
      .set('Authorization', `${ownerToken}`)
      .send({
        title: 'Test',
        assistancy: 'Test',
        province: 'Test',
        city: 'Test',
        longitude: 1,
        isPrecise: true,
        notes: ''
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['Must contain a \'latitude\' field!']);
  });

  it('CREATE /api/community-locations should reject items without longitude', async () => {
    const res = await requestWithSupertest
      .post('/api/community-locations')
      .set('Authorization', `${ownerToken}`)
      .send({
        title: 'Test',
        assistancy: 'Test',
        province: 'Test',
        city: 'Test',
        latitude: 1,
        isPrecise: true,
        notes: ''
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['Must contain a \'longitude\' field!']);
  });

  it('CREATE /api/community-locations should reject items with a non-string for title', async () => {
    const res = await requestWithSupertest
      .post('/api/community-locations')
      .set('Authorization', `${ownerToken}`)
      .send({
        title: 1,
        assistancy: 'Test',
        province: 'Test',
        city: 'Test',
        latitude: 1,
        longitude: 1,
        isPrecise: true,
        notes: ''
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['\'title\' must be of type \'string\'!']);
  });

  it('CREATE /api/community-locations should reject items with a non-string for assistancy', async () => {
    const res = await requestWithSupertest
      .post('/api/community-locations')
      .set('Authorization', `${ownerToken}`)
      .send({
        title: 'Test',
        assistancy: 1,
        province: 'Test',
        city: 'Test',
        latitude: 1,
        longitude: 1,
        isPrecise: true,
        notes: ''
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['\'assistancy\' must be of type \'string\'!']);
  });

  it('CREATE /api/community-locations should reject items with a non-string for province', async () => {
    const res = await requestWithSupertest
      .post('/api/community-locations')
      .set('Authorization', `${ownerToken}`)
      .send({
        title: 'Test',
        assistancy: 'Test',
        province: 1,
        city: 'Test',
        latitude: 1,
        longitude: 1,
        isPrecise: true,
        notes: ''
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['\'province\' must be of type \'string\'!']);
  });

  it('CREATE /api/community-locations should reject items with a non-string for city', async () => {
    const res = await requestWithSupertest
      .post('/api/community-locations')
      .set('Authorization', `${ownerToken}`)
      .send({
        title: 'Test',
        assistancy: 'Test',
        province: 'Test',
        city: 1,
        latitude: 1,
        longitude: 1,
        isPrecise: true,
        notes: ''
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['\'city\' must be of type \'string\'!']);
  });

  it('CREATE /api/community-locations should reject items with a non-number for latitude', async () => {
    const res = await requestWithSupertest
      .post('/api/community-locations')
      .set('Authorization', `${ownerToken}`)
      .send({
        title: 'Test',
        assistancy: 'Test',
        province: 'Test',
        city: 'Test',
        latitude: 'Test',
        longitude: 1,
        isPrecise: true,
        notes: ''
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['\'latitude\' must be of type \'number\'!']);
  });

  it('CREATE /api/community-locations should reject items with a non-number for longitude', async () => {
    const res = await requestWithSupertest
      .post('/api/community-locations')
      .set('Authorization', `${ownerToken}`)
      .send({
        title: 'Test',
        assistancy: 'Test',
        province: 'Test',
        city: 'Test',
        latitude: 1,
        longitude: 'Test',
        isPrecise: true,
        notes: ''
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['\'longitude\' must be of type \'number\'!']);
  });

  it('CREATE /api/community-locations should reject items with a non-boolean for isPrecise', async () => {
    const res = await requestWithSupertest
      .post('/api/community-locations')
      .set('Authorization', `${ownerToken}`)
      .send({
        title: 'Test',
        assistancy: 'Test',
        province: 'Test',
        city: 'Test',
        latitude: 1,
        longitude: 1,
        isPrecise: 'true',
        notes: ''
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['\'isPrecise\' must be of type \'boolean\'!']);
  });

  it('CREATE /api/community-locations should reject items with a non-string for notes', async () => {
    const res = await requestWithSupertest
      .post('/api/community-locations')
      .set('Authorization', `${ownerToken}`)
      .send({
        title: 'Test',
        assistancy: 'Test',
        province: 'Test',
        city: 'Test',
        latitude: 1,
        longitude: 1,
        isPrecise: true,
        notes: 1
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['\'notes\' must be of type \'string\'!']);
  });

  // test for change logs
  it('CREATE /api/community-locations should log a change', async () => {
    const itemRes = await requestWithSupertest
      .post('/api/community-locations')
      .set('Authorization', `${ownerToken}`)
      .send({
        title: 'Test',
        assistancy: 'Test',
        province: 'Test',
        city: 'Test',
        latitude: 1,
        longitude: 1,
        isPrecise: true,
        notes: ''
      });
    const changeRes = await requestWithSupertest
      .get(`/api/changes?page=0&size=5&table=CommunityLocations&action=Create&itemId=${itemRes.body.id}`)
      .set('Authorization', `${ownerToken}`);
    expect(changeRes.status).toEqual(200);
    expect(changeRes.type).toEqual(expect.stringContaining('json'));
    expect(changeRes.body.rows.length).toBeGreaterThanOrEqual(1);
    createdId = itemRes.body.id;
  });

});