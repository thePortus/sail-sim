const app = require('../../app.js');
const supertest = require('supertest');
const requestWithSupertest = supertest(app);

describe('StudyArea Endpoints', () => {

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
      .post('/api/study-areas')
      .set('Authorization', `${ownerToken}`)
      .send({
        title: 'Test StudyArea',
        description: 'Test Description',
        notes: ''
      });
    createdId = res.body.id;
  });

  afterEach(async () => {
    await requestWithSupertest
      .delete(`/api/study-areas/${createdId}`)
      .set('Authorization', `${ownerToken}`);
  });

  it('DELETE /api/study-areas/:id should delete a single study area by an owner', async () => {
    const res = await requestWithSupertest.delete('/api/study-areas/' + createdId.toString())
      .set('Authorization', `${ownerToken}`);
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', 'StudyArea was deleted successfully!');
  });

  it('DELETE /api/study-areas/:id should delete a single study area by an admin', async () => {
    const res = await requestWithSupertest.delete('/api/study-areas/' + createdId.toString())
      .set('Authorization', `${adminToken}`);
    expect(res.status).toEqual(200);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', 'StudyArea was deleted successfully!');
  });

  it('DELETE /api/study-areas/:id should reject a request by an editor', async () => {
    const res = await requestWithSupertest.delete('/api/study-areas/' + createdId.toString())
      .set('Authorization', `${editorToken}`);
    expect(res.status).toEqual(401);
  });

  it('DELETE /api/study-areas/:id should reject request without proper authorization', async () => {
    const res = await requestWithSupertest.delete('/api/study-areas/' + createdId.toString())
      .set('Authorization', `${editorToken}`);
    expect(res.status).toEqual(401);
  });

  it('DELETE /api/study-areas/:id should reject deleting an unknown study area', async () => {
    const res = await requestWithSupertest.delete('/api/study-areas/9999')
      .set('Authorization', `${ownerToken}`);
    expect(res.status).toEqual(500);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', 'Cannot delete StudyArea with id=9999. Maybe StudyArea was not found!');
  });

  it('DELETE /api/study-areas/:id should reject request without proper authorization', async () => {
    const res = await requestWithSupertest.delete('/api/study-areas/' + createdId.toString());
    expect(res.status).toEqual(401);
  });

  it('DELETE /api/study-areas/:id should reject request from a regular user without elevated privileges', async () => {
    const res = await requestWithSupertest.delete('/api/study-areas/' + createdId.toString())
      .set('Authorization', `${userToken}`);
    expect(res.status).toEqual(401);
  });

  it('DELETE /api/study-areas/:id should reject deleting a study area referenced by other tables', async () => {
    const languageResponse = await requestWithSupertest
      .post('/api/languages')
      .set('Authorization', `${ownerToken}`)
      .send({
        title: 'Testing Language with References'
      });
    const jesuitResponse = await requestWithSupertest
      .post('/api/jesuits')
      .set('Authorization', `${ownerToken}`)
      .send({
        firstName: 'Test',
        lastName: 'Jesuit'
      });
    const sourceResponse = await requestWithSupertest
      .post('/api/sources')
      .set('Authorization', `${ownerToken}`)
      .send({
        idBox: 'Test Box',
        archive: 'Test Archive, Offices',
        volume: 'Test Volume',
        page: 'Test Page',
      });
    const communityLocationResponse = await requestWithSupertest
      .post('/api/community-locations')
      .set('Authorization', `${ownerToken}`)
      .send({
        title: 'Test Location',
        assistancy: 'Test Assistancy',
        province: 'Test Province',
        city: 'Test City',
        latitude: 1,
        longitude: 1,
        isPrecise: true
      });
    const communityResponse = await requestWithSupertest
      .post('/api/communities')
      .set('Authorization', `${ownerToken}`)
      .send({
        title: 'Test Community',
        type: 'Test Type'
      });
    const communityAtLocationResponse = await requestWithSupertest
      .post('/api/communities-at-locations')
      .set('Authorization', `${ownerToken}`)
      .send({
        communityId: communityResponse.body.id,
        communityLocationId: communityLocationResponse.body.id,
        startYear: 2000,
        startMonth: 1,
        startDay: 1,
        endYear: 2020,
        endMonth: 1,
        endDay: 1
      });
    const firstCatalogResponse = await requestWithSupertest
      .post('/api/first-catalogs')
      .set('Authorization', `${ownerToken}`)
      .send({
        title: 'Test First Catalog',
        jesuitId: jesuitResponse.body.id,
        communityId: communityResponse.body.id,
        communityLocationId: communityLocationResponse.body.id,
        communityAtLocationId: communityAtLocationResponse.body.id,
        catalogYear: 2015,
        year: 2015,
        month: 1,
        day: 1,
        healthState: 'Healthy',
        healthStateExpanded: 'Healthy Expanded',
        entryKey: 1,
        entryKeyAttributed: false,
        sourceId: sourceResponse.body.id,
        languageId: languageResponse.body.id,
      });
    const jesuitStudyingAreaResponse = await requestWithSupertest
      .post('/api/jesuits-studying-areas')
      .set('Authorization', `${ownerToken}`)
      .send({
        firstCatalogId: firstCatalogResponse.body.id,
        studyAreaId: createdId,
        duration: '2 years',
        inSociety: true
      });
    const res = await requestWithSupertest.delete('/api/study-areas/' + createdId.toString())
      .set('Authorization', `${ownerToken}`);
    expect(res.status).toEqual(500);
    expect(res.type).toEqual(expect.stringContaining('json'));
    expect(res.body).toHaveProperty('message', 'Cannot delete StudyArea due to existing references in other tables');
    await requestWithSupertest.delete(`/api/jesuits-studying-areas/${jesuitStudyingAreaResponse.body.id}`)
      .set('Authorization', `${ownerToken}`);
    await requestWithSupertest.delete(`/api/first-catalogs/${firstCatalogResponse.body.id}`)
      .set('Authorization', `${ownerToken}`);
    await requestWithSupertest.delete(`/api/communities-at-locations/${communityAtLocationResponse.body.id}`)
      .set('Authorization', `${ownerToken}`);
    await requestWithSupertest.delete(`/api/community-locations/${communityLocationResponse.body.id}`)
      .set('Authorization', `${ownerToken}`);
    await requestWithSupertest.delete(`/api/communities/${communityResponse.body.id}`)
      .set('Authorization', `${ownerToken}`);
    await requestWithSupertest.delete(`/api/sources/${sourceResponse.body.id}`)
      .set('Authorization', `${ownerToken}`);
    await requestWithSupertest.delete(`/api/languages/${languageResponse.body.id}`)
      .set('Authorization', `${ownerToken}`);
    await requestWithSupertest.delete(`/api/jesuits/${jesuitResponse.body.id}`)
      .set('Authorization', `${ownerToken}`);
  });

  it('DELETE /api/study-areas/:id should log a change', async () => {
    await requestWithSupertest.delete('/api/study-areas/' + createdId.toString())
      .set('Authorization', `${ownerToken}`);
    const changeRes = await requestWithSupertest
      .get(`/api/changes?page=0&size=5&table=StudyAreas&action=Delete&itemId=${createdId}`)
      .set('Authorization', `${ownerToken}`);
    expect(changeRes.status).toEqual(200);
    expect(changeRes.type).toEqual(expect.stringContaining('json'));
    expect(changeRes.body.rows.length).toBeGreaterThanOrEqual(1);
  });

});