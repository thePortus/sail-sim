const app = require('../../app.js');
const supertest = require('supertest');
const requestWithSupertest = supertest(app);

describe('Jesuit Update Endpoints', () => {
  
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
      .post('/api/jesuits')
      .set('Authorization', `${ownerToken}`)
      .send({
        firstName: 'Test',
        lastName: 'Test',
        notes: ''
      });
    createdId = res.body.id;
  });

  afterEach(async () => {
    await requestWithSupertest
      .delete(`/api/jesuits/${createdId}`)
      .set('Authorization', `${ownerToken}`);
  });

  it('UPDATE /api/jesuits/:id should update a single jesuit by an owner', async () => {
    const res = await requestWithSupertest.put('/api/jesuits/' + createdId.toString())
      .set('Authorization', `${ownerToken}`)
      .send({
        id: createdId,
        firstName: 'Updated Test',
        lastName: 'Updated Test',
      });
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', 'Jesuit was updated successfully.');
  });

  it('UPDATE /api/jesuits/:id should update a single jesuit by an admin', async () => {
    const res = await requestWithSupertest.put('/api/jesuits/' + createdId.toString())
      .set('Authorization', `${adminToken}`)
      .send({
        id: createdId,
        firstName: 'Updated Test',
        lastName: 'Updated Test',
      });
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', 'Jesuit was updated successfully.');
  });

  it('UPDATE /api/jesuits/:id should update a single jesuit by an editor', async () => {
    const res = await requestWithSupertest.put('/api/jesuits/' + createdId.toString())
      .set('Authorization', `${editorToken}`)
      .send({
        id: createdId,
        firstName: 'Updated Test',
        lastName: 'Updated Test',
      });
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', 'Jesuit was updated successfully.');
  });

  it('UPDATE /api/jesuits/:id should reject a request without proper authorization', async () => {
    const res = await requestWithSupertest.put('/api/jesuits/' + createdId.toString())
      .send({
        id: createdId,
        firstName: 'Updated Test',
        lastName: 'Updated Test',
      });
    expect(res.status).toEqual(401);
  });

  it('UPDATE /api/jesuits/:id should reject a request from regular users without privileges', async () => {
    const res = await requestWithSupertest.put('/api/jesuits/' + createdId.toString())
      .set('Authorization', `${userToken}`)
      .send({
        id: createdId,
        firstName: 'Updated Test',
        lastName: 'Updated Test',
      });
    expect(res.status).toEqual(401);
  });

  it('UPDATE /api/jesuits/:id should reject request for unknown item', async () => {
    const res = await requestWithSupertest.put('/api/jesuits/9999')
      .set('Authorization', `${ownerToken}`)
      .send({
        id: '9999',
        firstName: 'Updated Test',
        lastName: 'Updated Test',
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['Cannot update jesuit with id=9999. Maybe jesuit was not found!']);
  });

  it('UPDATE /api/jesuits/:id should reject request which would update to an empty name', async () => {
    const res = await requestWithSupertest.put('/api/jesuits/' + createdId.toString())
      .set('Authorization', `${ownerToken}`)
      .send({
        id: createdId,
        firstName: '',
        lastName: '',
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['Must contain either a \'firstName\' or \'lastName\' field!']);
  });

  it('UPDATE /api/jesuits/:id should reject request with a non-string for firstName', async () => {
    const res = await requestWithSupertest.put('/api/jesuits/' + createdId.toString())
      .set('Authorization', `${ownerToken}`)
      .send({
        id: createdId,
        firstName: 1,
        lastName: '',
        notes: ''
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['\'firstName\' must be of type \'string\'!']);
  });

  it('UPDATE /api/jesuits/:id should reject request with a non-string for lastName', async () => {
    const res = await requestWithSupertest.put('/api/jesuits/' + createdId.toString())
      .set('Authorization', `${ownerToken}`)
      .send({
        id: createdId,
        firstName: '',
        lastName: 1,
        notes: ''
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['\'lastName\' must be of type \'string\'!']);
  });

  it('UPDATE /api/jesuits/:id should reject request with a non-string for notes', async () => {
    const res = await requestWithSupertest.put('/api/jesuits/' + createdId.toString())
      .set('Authorization', `${ownerToken}`)
      .send({
        id: createdId,
        firstName: 'Test',
        lastName: 'Test',
        notes: 1
      });
    expect(res.status).toEqual(500);
    expect(res.body).toHaveProperty('message', ['\'notes\' must be of type \'string\'!']);
  });

  it('DELETE /api/jesuits/:id should delete a single jesuit by an owner', async () => {
    const res = await requestWithSupertest.delete('/api/jesuits/' + createdId.toString())
      .set('Authorization', `${ownerToken}`);
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', 'Jesuit was deleted successfully!');
  });

  it('DELETE /api/jesuits/:id should delete a single jesuit by an admin', async () => {
    const res = await requestWithSupertest.delete('/api/jesuits/' + createdId.toString())
      .set('Authorization', `${adminToken}`);
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', 'Jesuit was deleted successfully!');
  });

  it('DELETE /api/jesuits/:id should delete a single jesuit by an editor', async () => {
    const res = await requestWithSupertest.delete('/api/jesuits/' + createdId.toString())
      .set('Authorization', `${editorToken}`);
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', 'Jesuit was deleted successfully!');
  });

  it('DELETE /api/jesuits/:id should reject deleting an unknown jesuit', async () => {
    const res = await requestWithSupertest.delete('/api/jesuits/9999')
      .set('Authorization', `${ownerToken}`);
    expect(res.status).toEqual(500);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', 'Cannot delete jesuit with id=9999. Maybe jesuit was not found!');
  });

  it('DELETE /api/jesuits/:id should reject request without proper authorization', async () => {
    const res = await requestWithSupertest.delete('/api/jesuits/' + createdId.toString());
    expect(res.status).toEqual(401);
  });

  it('DELETE /api/jesuits/:id should reject request from regular users without privileges', async () => {
    const res = await requestWithSupertest.delete('/api/jesuits/' + createdId.toString())
      .set('Authorization', `${userToken}`);
    expect(res.status).toEqual(401);
  });

  it('UPDATE /api/jesuits/:id should log a change', async () => {
    await requestWithSupertest.put('/api/jesuits/' + createdId.toString())
      .set('Authorization', `${ownerToken}`)
      .send({
        firstName: 'Testing',
      });
    const changeRes = await requestWithSupertest
      .get(`/api/changes?page=0&size=5&table=Jesuits&action=Update&itemId=${createdId}`)
      .set('Authorization', `${ownerToken}`);
    expect(changeRes.status).toEqual(200);
    expect(changeRes.type).toEqual(expect.stringContaining('json'));
    expect(changeRes.body.rows.length).toBeGreaterThanOrEqual(1);
  });

});