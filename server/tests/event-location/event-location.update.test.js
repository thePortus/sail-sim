const app = require('../../app.js');
const supertest = require('supertest');
const requestWithSupertest = supertest(app);

describe('EventLocation Endpoints', () => {

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
      .post('/api/event-locations')
      .set('Authorization', `${ownerToken}`)
      .send({
        title: 'Test',
        type: 'Test',
        isPrecise: true,
        latitude: 42.361145,
        longitude: -71.057083,
        notes: ''
      });
    createdId = res.body.id;
  });

  afterEach(async () => {
    await requestWithSupertest
      .delete(`/api/event-locations/${createdId}`)
      .set('Authorization', `${ownerToken}`);
  });

  it('UPDATE /api/event-locations/:id should update a single eventLocation by owner', async () => {
    const res = await requestWithSupertest.put('/api/event-locations/' + createdId.toString())
      .set('Authorization', `${ownerToken}`)
      .send({
        id: createdId,
        title: 'Updated Test',
        type: 'Updated Test',
      });
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', 'EventLocation was updated successfully.');
  });

  it('UPDATE /api/event-locations/:id should update a single eventLocation by admin', async () => {
    const res = await requestWithSupertest.put('/api/event-locations/' + createdId.toString())
      .set('Authorization', `${adminToken}`)
      .send({
        id: createdId,
        title: 'Updated Test',
        type: 'Updated Test',
      });
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', 'EventLocation was updated successfully.');
  });

  it('UPDATE /api/event-locations/:id should update reject request without proper authorization', async () => {
    const res = await requestWithSupertest.put('/api/event-locations/' + createdId.toString())
      .send({
        id: createdId,
        title: 'Updated Test',
        type: 'Updated Test',
      });
    expect(res.status).toEqual(401);
  });

  it('UPDATE /api/event-locations/:id should update reject request from editor', async () => {
    const res = await requestWithSupertest.put('/api/event-locations/' + createdId.toString())
      .set('Authorization', `${editorToken}`)
      .send({
        id: createdId,
        title: 'Updated Test',
        type: 'Updated Test',
      });
    expect(res.status).toEqual(401);
  });

  it('UPDATE /api/event-locations/:id should update reject request from regular users without privileges', async () => {
    const res = await requestWithSupertest.put('/api/event-locations/' + createdId.toString())
      .set('Authorization', `${userToken}`)
      .send({
        id: createdId,
        title: 'Updated Test',
        type: 'Updated Test',
      });
    expect(res.status).toEqual(401);
  });

  it('UPDATE /api/event-locations/:id should update reject request for unknown item', async () => {
    const res = await requestWithSupertest.put('/api/event-locations/9999')
      .set('Authorization', `${ownerToken}`)
      .send({
        id: '9999',
        title: 'Updated Test',
        type: 'Updated Test',
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', 'Cannot update EventLocation with id=9999. Maybe EventLocation was not found!');
  });

  it('UPDATE /api/event-locations/:id should reject items with titles that are not strings', async () => {
    const res = await requestWithSupertest
      .put('/api/event-locations/' + createdId.toString())
      .set('Authorization', `${ownerToken}`)
      .send({
        title: 1
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['\'title\' must be of type \'string\'!']);
  });

  it('UPDATE /api/event-locations/:id should reject items with types that are not strings', async () => {
    const res = await requestWithSupertest
      .put('/api/event-locations/' + createdId.toString())
      .set('Authorization', `${ownerToken}`)
      .send({
        type: 1
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['\'type\' must be of type \'string\'!']);
  });

  it('UPDATE /api/event-locations/:id should reject items with isPrecise that are not boolean', async () => {
    const res = await requestWithSupertest
      .put('/api/event-locations/' + createdId.toString())
      .set('Authorization', `${ownerToken}`)
      .send({
        isPrecise: 'true'
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['\'isPrecise\' must be of type \'boolean\'!']);
  });

  it('UPDATE /api/event-locations/:id should reject items with latitude that are not numbers', async () => {
    const res = await requestWithSupertest
      .put('/api/event-locations/' + createdId.toString())
      .set('Authorization', `${ownerToken}`)
      .send({
        latitude: 'Test'
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['\'latitude\' must be of type \'number\'!']);
  });

  it('UPDATE /api/event-locations/:id should reject items with longitude that are not numbers', async () => {
    const res = await requestWithSupertest
      .put('/api/event-locations/' + createdId.toString())
      .set('Authorization', `${ownerToken}`)
      .send({
        longitude: 'Test'
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['\'longitude\' must be of type \'number\'!']);
  });

  it('UPDATE /api/event-locations/:id should reject items with isPrecise that are not notes', async () => {
    const res = await requestWithSupertest
      .put('/api/event-locations/' + createdId.toString())
      .set('Authorization', `${ownerToken}`)
      .send({
        notes: 1
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['\'notes\' must be of type \'string\'!']);
  });

  // test for change logs
  it('UPDATE /api/event-locations/:id should log a change', async () => {
    await requestWithSupertest.put('/api/event-locations/' + createdId.toString())
      .set('Authorization', `${ownerToken}`)
      .send({
        title: 'Updated Test',
      });
    const changeRes = await requestWithSupertest
      .get(`/api/changes?page=0&size=5&table=EventLocations&action=Update&itemId=${createdId}`)
      .set('Authorization', `${ownerToken}`);
    expect(changeRes.status).toEqual(200);
    expect(changeRes.type).toEqual(expect.stringContaining('json'));
    expect(changeRes.body.rows.length).toBeGreaterThanOrEqual(1);
  });

});