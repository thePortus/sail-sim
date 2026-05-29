const app = require('../../app.js');
const supertest = require('supertest');
const requestWithSupertest = supertest(app);

describe('Jesuit Create Endpoints', () => {
  
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
    const res = await requestWithSupertest
      .delete(`/api/jesuits/${createdId}`)
      .set('Authorization', `${ownerToken}`);
  });

  it('CREATE /api/jesuits should accept valid data from an owner', async () => {
    const res = await requestWithSupertest
      .post('/api/jesuits')
      .set('Authorization', `${ownerToken}`)
      .send({
        firstName: 'Valid',
        lastName: 'Jesuit',
        notes: ''
      });
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('firstName');
    expect(res.body).toHaveProperty('lastName');
    expect(res.body).toHaveProperty('notes');
    createdId = res.body.id;
  });

  it('CREATE /api/jesuits should accept valid data from an admin', async () => {
    const res = await requestWithSupertest
      .post('/api/jesuits')
      .set('Authorization', `${adminToken}`)
      .send({
        firstName: 'Valid',
        lastName: 'Jesuit',
        notes: ''
      });
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('firstName');
    expect(res.body).toHaveProperty('lastName');
    expect(res.body).toHaveProperty('notes');
    createdId = res.body.id;
  });

  it('CREATE /api/jesuits should accept valid data from an editor', async () => {
    const res = await requestWithSupertest
      .post('/api/jesuits')
      .set('Authorization', `${editorToken}`)
      .send({
        firstName: 'Valid',
        lastName: 'Jesuit',
        notes: ''
      });
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('firstName');
    expect(res.body).toHaveProperty('lastName');
    expect(res.body).toHaveProperty('notes');
    createdId = res.body.id;
  });

  it('CREATE /api/jesuits should reject request without proper authorization', async () => {
    const res = await requestWithSupertest
      .post('/api/jesuits')
      .send({
        firstName: 'Test',
        lastName: 'Test',
        notes: ''
      });
    expect(res.status).toEqual(401);
  });

  it('CREATE /api/jesuits should reject request from regular users without privileges', async () => {
    const res = await requestWithSupertest
      .post('/api/jesuits')
      .set('Authorization', `${userToken}`)
      .send({
        firstName: 'Test',
        lastName: 'Test',
        notes: ''
      });
    expect(res.status).toEqual(401);
  });

  it('CREATE /api/jesuits should reject items without first & last names', async () => {
    const res = await requestWithSupertest
      .post('/api/jesuits')
      .set('Authorization', `${ownerToken}`)
      .send({
        notes: ''
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['Must contain either a \'firstName\' or \'lastName\' field!']);
  });

  it('CREATE /api/jesuits should reject items with a non-string for a firstName', async () => {
    const res = await requestWithSupertest
      .post('/api/jesuits')
      .set('Authorization', `${ownerToken}`)
      .send({
        firstName: 1,
        lastName: 'Test',
        notes: ''
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['\'firstName\' must be of type \'string\'!']);
  });

  it('CREATE /api/jesuits should reject items with a non-string for a lastName', async () => {
    const res = await requestWithSupertest
      .post('/api/jesuits')
      .set('Authorization', `${ownerToken}`)
      .send({
        firstName: 'Test',
        lastName: 1,
        notes: ''
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['\'lastName\' must be of type \'string\'!']);
  });

  it('CREATE /api/jesuits should reject items with a non-string for notes', async () => {
    const res = await requestWithSupertest
      .post('/api/jesuits')
      .set('Authorization', `${ownerToken}`)
      .send({
        firstName: 'Test',
        lastName: 'Test',
        notes: 1
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['\'notes\' must be of type \'string\'!']);
  });

  it('CREATE /api/jesuits should log a change', async () => {
    const itemRes = await requestWithSupertest
      .post('/api/jesuits')
      .set('Authorization', `${ownerToken}`)
      .send({
        firstName: 'Valid',
        lastName: 'Jesuit',
        notes: ''
      });
    const changeRes = await requestWithSupertest
      .get(`/api/changes?page=0&size=5&table=Jesuits&action=Create&itemId=${itemRes.body.id}`)
      .set('Authorization', `${ownerToken}`);
    expect(changeRes.status).toEqual(200);
    expect(changeRes.type).toEqual(expect.stringContaining('json'));
    expect(changeRes.body.rows.length).toBeGreaterThanOrEqual(1);
    createdId = itemRes.body.id;
  });

});