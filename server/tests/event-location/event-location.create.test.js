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

  afterEach(async () => {
    await requestWithSupertest
      .delete(`/api/event-locations/${createdId}`)
      .set('Authorization', `${ownerToken}`);
  });

  it('CREATE /api/event-locations should accept valid data from owner', async () => {
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
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('title');
    expect(res.body).toHaveProperty('type');
    expect(res.body).toHaveProperty('isPrecise');
    expect(res.body).toHaveProperty('latitude');
    expect(res.body).toHaveProperty('longitude');
    expect(res.body).toHaveProperty('notes');
    createdId = res.body.id;
  });
  
  it('CREATE /api/event-locations should accept valid data from admin', async () => {
    const res = await requestWithSupertest
      .post('/api/event-locations')
      .set('Authorization', `${adminToken}`)
      .send({
        title: 'Test',
        type: 'Test',
        isPrecise: true,
        latitude: 42.361145,
        longitude: -71.057083,
        notes: ''
      });
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('title');
    expect(res.body).toHaveProperty('type');
    expect(res.body).toHaveProperty('isPrecise');
    expect(res.body).toHaveProperty('latitude');
    expect(res.body).toHaveProperty('longitude');
    expect(res.body).toHaveProperty('notes');
    createdId = res.body.id;
  });

  it('CREATE /api/event-locations should reject request without proper authorization', async () => {
    const res = await requestWithSupertest
      .post('/api/event-locations')
      .send({
        title: 'Test',
        type: 'Test',
        isPrecise: true,
        latitude: 42.361145,
        longitude: -71.057083,
        notes: ''
      });
    expect(res.status).toEqual(401);
  });

  it('CREATE /api/event-locations should reject request from editors', async () => {
    const res = await requestWithSupertest
      .post('/api/event-locations')
      .set('Authorization', `${editorToken}`)
      .send({
        title: 'Test',
        type: 'Test',
        isPrecise: true,
        latitude: 42.361145,
        longitude: -71.057083,
        notes: ''
      });
    expect(res.status).toEqual(401);
  });

  it('CREATE /api/event-locations should reject request from regular users without privileges', async () => {
    const res = await requestWithSupertest
      .post('/api/event-locations')
      .set('Authorization', `${userToken}`)
      .send({
        title: 'Test',
        type: 'Test',
        isPrecise: true,
        latitude: 42.361145,
        longitude: -71.057083,
        notes: ''
      });
    expect(res.status).toEqual(401);
  });

  it('CREATE /api/event-locations should reject items without title', async () => {
    const res = await requestWithSupertest
      .post('/api/event-locations')
      .set('Authorization', `${ownerToken}`)
      .send({
        type: 'Test',
        isPrecise: true,
        latitude: 42.361145,
        longitude: -71.057083,
        notes: ''
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['Must contain a \'title\' field!']);
  });

  it('CREATE /api/event-locations should reject items without type', async () => {
    const res = await requestWithSupertest
      .post('/api/event-locations')
      .set('Authorization', `${ownerToken}`)
      .send({
        title: 'Test',
        isPrecise: true,
        latitude: 42.361145,
        longitude: -71.057083,
        notes: ''
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['Must contain a \'type\' field!']);
  });

  it('CREATE /api/event-locations should reject items without latitude', async () => {
    const res = await requestWithSupertest
      .post('/api/event-locations')
      .set('Authorization', `${ownerToken}`)
      .send({
        title: 'Test',
        type: 'Type',
        isPrecise: true,
        longitude: -71.057083,
        notes: ''
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['Must contain a \'latitude\' field!']);
  });

  it('CREATE /api/event-locations should reject items without longitude', async () => {
    const res = await requestWithSupertest
      .post('/api/event-locations')
      .set('Authorization', `${ownerToken}`)
      .send({
        title: 'Test',
        type: 'Type',
        isPrecise: true,
        latitude: 42.361145,
        notes: ''
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['Must contain a \'longitude\' field!']);
  });

  it('CREATE /api/event-locations should reject items with titles that are not strings', async () => {
    const res = await requestWithSupertest
      .post('/api/event-locations')
      .set('Authorization', `${ownerToken}`)
      .send({
        title: 1,
        type: 'Type',
        isPrecise: true,
        latitude: 42.361145,
        longitude: -71.057083,
        notes: ''
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['\'title\' must be of type \'string\'!']);
  });

  it('CREATE /api/event-locations should reject items with types that are not strings', async () => {
    const res = await requestWithSupertest
      .post('/api/event-locations')
      .set('Authorization', `${ownerToken}`)
      .send({
        title: 'Test',
        type: 1,
        isPrecise: true,
        latitude: 42.361145,
        longitude: -71.057083,
        notes: ''
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['\'type\' must be of type \'string\'!']);
  });

  it('CREATE /api/event-locations should reject items with latitude that are not numbers', async () => {
    const res = await requestWithSupertest
      .post('/api/event-locations')
      .set('Authorization', `${ownerToken}`)
      .send({
        title: 'Test',
        type: 'Test',
        isPrecise: true,
        latitude: 'Test',
        longitude: -71.057083,
        notes: ''
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['\'latitude\' must be of type \'number\'!']);
  });

  it('CREATE /api/event-locations should reject items with longitude that are not numbers', async () => {
    const res = await requestWithSupertest
      .post('/api/event-locations')
      .set('Authorization', `${ownerToken}`)
      .send({
        title: 'Test',
        type: 'Test',
        isPrecise: true,
        latitude: 42.361145,
        longitude: 'Test',
        notes: ''
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['\'longitude\' must be of type \'number\'!']);
  });

  it('CREATE /api/event-locations should reject items with isPrecise that are not boolean', async () => {
    const res = await requestWithSupertest
      .post('/api/event-locations')
      .set('Authorization', `${ownerToken}`)
      .send({
        title: 'Test',
        type: 'Test',
        isPrecise: 'true',
        latitude: 42.361145,
        longitude: -71.057083,
        notes: ''
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['\'isPrecise\' must be of type \'boolean\'!']);
  });

  it('CREATE /api/event-locations should reject items with notes that are not strings', async () => {
    const res = await requestWithSupertest
      .post('/api/event-locations')
      .set('Authorization', `${ownerToken}`)
      .send({
        title: 'Test',
        type: 'Test',
        isPrecise: true,
        latitude: 42.361145,
        longitude: -71.057083,
        notes: 3
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['\'notes\' must be of type \'string\'!']);
  });

  // test for change logs
  it('CREATE /api/event-locations should log a change', async () => {
    const itemRes = await requestWithSupertest
      .post('/api/event-locations')
      .set('Authorization', `${ownerToken}`)
      .send({
        title: 'Test',
        latitude: 1,
        longitude: 1,
        type: 'Test',
        isPrecise: true,
        notes: ''
      });
    const changeRes = await requestWithSupertest
      .get(`/api/changes?page=0&size=5&table=EventLocations&action=Create&itemId=${itemRes.body.id}`)
      .set('Authorization', `${ownerToken}`);
    expect(changeRes.status).toEqual(200);
    expect(changeRes.type).toEqual(expect.stringContaining('json'));
    expect(changeRes.body.rows.length).toBeGreaterThanOrEqual(1);
    createdId = itemRes.body.id;
  });

});