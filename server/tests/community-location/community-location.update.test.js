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

  beforeEach(async () => {
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
    createdId = res.body.id;
  });

  afterEach(async () => {
    await requestWithSupertest
      .delete(`/api/community-locations/${createdId}`)
      .set('Authorization', `${ownerToken}`);
  });

  it('UPDATE /api/community-locations/:id should update a single community location by owner', async () => {
    const res = await requestWithSupertest
      .put('/api/community-locations/' + createdId.toString())
      .set('Authorization', `${ownerToken}`)
      .send({
        id: createdId,
        title: 'Updated Test',
        latitude: 2,
        longitude: 2,
        isPrecise: false,
      });
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', 'CommunityLocation was updated successfully.');
  });

  it('UPDATE /api/community-locations/:id should update a single community location by admin', async () => {
    const res = await requestWithSupertest
      .put('/api/community-locations/' + createdId.toString())
      .set('Authorization', `${adminToken}`)
      .send({
        id: createdId,
        title: 'Updated Test',
        latitude: 2,
        longitude: 2,
        isPrecise: false,
      });
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', 'CommunityLocation was updated successfully.');
  });

  it('UPDATE /api/community-locations/:id should update reject request without proper authorization', async () => {
    const res = await requestWithSupertest
      .put('/api/community-locations/' + createdId.toString())
      .send({
        id: createdId,
        title: 'Updated Test',
        latitude: 2,
        longitude: 2,
        isPrecise: false,
      });
    expect(res.status).toEqual(401);
  });

  it('UPDATE /api/community-locations/:id should update reject request by editors', async () => {
    const res = await requestWithSupertest
      .put('/api/community-locations/' + createdId.toString())
      .set('Authorization', `${editorToken}`)
      .send({
        id: createdId,
        title: 'Updated Test',
        latitude: 2,
        longitude: 2,
        isPrecise: false,
      });
    expect(res.status).toEqual(401);
  });

  it('UPDATE /api/community-locations/:id should update reject request by regular users without privileges', async () => {
    const res = await requestWithSupertest
      .put('/api/community-locations/' + createdId.toString())
      .set('Authorization', `${userToken}`)
      .send({
        id: createdId,
        title: 'Updated Test',
        latitude: 2,
        longitude: 2,
        isPrecise: false,
      });
    expect(res.status).toEqual(401);
  });

  it('UPDATE /api/community-locations/:id should update reject request for unknown item', async () => {
    const res = await requestWithSupertest
      .put('/api/community-locations/9999')
      .set('Authorization', `${ownerToken}`)
      .send({
        id: createdId,
        title: 'Updated Test',
        latitude: 2,
        longitude: 2,
        isPrecise: false,
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', 'Cannot update CommunityLocation with id=9999. Maybe CommunityLocation was not found!');
  });

  it('UPDATE /api/community-locations should reject items with a non-string for title', async () => {
    const res = await requestWithSupertest
      .put('/api/community-locations/' + createdId.toString())
      .set('Authorization', `${ownerToken}`)
      .send({
        title: 1
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['\'title\' must be of type \'string\'!']);
  });

  it('UPDATE /api/community-locations should reject items with a non-string for assistancy', async () => {
    const res = await requestWithSupertest
      .put('/api/community-locations/' + createdId.toString())
      .set('Authorization', `${ownerToken}`)
      .send({
        assistancy: 1,
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['\'assistancy\' must be of type \'string\'!']);
  });

  it('UPDATE /api/community-locations should reject items with a non-string for province', async () => {
    const res = await requestWithSupertest
      .put('/api/community-locations/' + createdId.toString())
      .set('Authorization', `${ownerToken}`)
      .send({
        province: 1,
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['\'province\' must be of type \'string\'!']);
  });

  it('UPDATE /api/community-locations should reject items with a non-string for city', async () => {
    const res = await requestWithSupertest
      .put('/api/community-locations/' + createdId.toString())
      .set('Authorization', `${ownerToken}`)
      .send({
        city: 1,
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['\'city\' must be of type \'string\'!']);
  });

  it('UPDATE /api/community-locations should reject items with a non-number for latitude', async () => {
    const res = await requestWithSupertest
      .put('/api/community-locations/' + createdId.toString())
      .set('Authorization', `${ownerToken}`)
      .send({
        latitude: 'Test',
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['\'latitude\' must be of type \'number\'!']);
  });

  it('UPDATE /api/community-locations should reject items with a non-number for longitude', async () => {
    const res = await requestWithSupertest
      .put('/api/community-locations/' + createdId.toString())
      .set('Authorization', `${ownerToken}`)
      .send({
        longitude: 'Test',
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['\'longitude\' must be of type \'number\'!']);
  });

  it('UPDATE /api/community-locations should reject items with a non-string for isPrecise', async () => {
    const res = await requestWithSupertest
      .put('/api/community-locations/' + createdId.toString())
      .set('Authorization', `${ownerToken}`)
      .send({
        isPrecise: 'true',
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['\'isPrecise\' must be of type \'boolean\'!']);
  });

  it('UPDATE /api/community-locations should reject items with a non-string for notes', async () => {
    const res = await requestWithSupertest
      .put('/api/community-locations/' + createdId.toString())
      .set('Authorization', `${ownerToken}`)
      .send({
        notes: 1
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['\'notes\' must be of type \'string\'!']);
  });

  // test for change logs
  it('UPDATE /api/community-locations/:id should log a change', async () => {
    await requestWithSupertest.put('/api/community-locations/' + createdId.toString())
      .set('Authorization', `${ownerToken}`)
      .send({
        title: 'Testing'
      });
    const changeRes = await requestWithSupertest
      .get(`/api/changes?page=0&size=5&table=CommunityLocations&action=Update&itemId=${createdId}`)
      .set('Authorization', `${ownerToken}`);
    expect(changeRes.status).toEqual(200);
    expect(changeRes.type).toEqual(expect.stringContaining('json'));
    expect(changeRes.body.rows.length).toBeGreaterThanOrEqual(1);
  });
  
});