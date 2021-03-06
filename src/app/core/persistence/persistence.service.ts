import {Injectable} from '@angular/core';
import {
  AllowedDBKeys,
  LS_BACKUP,
  LS_BOOKMARK_STATE,
  LS_GLOBAL_CFG,
  LS_IMPROVEMENT_STATE,
  LS_LAST_LOCAL_SYNC_MODEL_CHANGE,
  LS_METRIC_STATE,
  LS_NOTE_STATE,
  LS_OBSTRUCTION_STATE,
  LS_PROJECT_ARCHIVE,
  LS_PROJECT_META_LIST,
  LS_PROJECT_PREFIX,
  LS_REMINDER,
  LS_SIMPLE_COUNTER_STATE,
  LS_TAG_STATE,
  LS_TASK_ARCHIVE,
  LS_TASK_REPEAT_CFG_STATE,
  LS_TASK_STATE
} from './ls-keys.const';
import {GlobalConfigState} from '../../features/config/global-config.model';
import {projectReducer, ProjectState} from '../../features/project/store/project.reducer';
import {ArchiveTask, Task, TaskArchive, TaskState} from '../../features/tasks/task.model';
import {AppBaseData, AppDataComplete, AppDataForProjects, DEFAULT_APP_BASE_DATA} from '../../imex/sync/sync.model';
import {BookmarkState} from '../../features/bookmark/store/bookmark.reducer';
import {NoteState} from '../../features/note/store/note.reducer';
import {Reminder} from '../../features/reminder/reminder.model';
import {SnackService} from '../snack/snack.service';
import {DatabaseService} from './database.service';
import {DEFAULT_PROJECT_ID} from '../../features/project/project.const';
import {
  ExportedProject,
  ProjectArchive,
  ProjectArchivedRelatedData
} from '../../features/project/project-archive.model';
import {Project} from '../../features/project/project.model';
import {CompressionService} from '../compression/compression.service';
import {PersistenceBaseEntityModel, PersistenceBaseModel, PersistenceForProjectModel} from './persistence.model';
import {Metric, MetricState} from '../../features/metric/metric.model';
import {Improvement, ImprovementState} from '../../features/metric/improvement/improvement.model';
import {Obstruction, ObstructionState} from '../../features/metric/obstruction/obstruction.model';
import {TaskRepeatCfg, TaskRepeatCfgState} from '../../features/task-repeat-cfg/task-repeat-cfg.model';
import {Bookmark} from '../../features/bookmark/bookmark.model';
import {Note} from '../../features/note/note.model';
import {Action} from '@ngrx/store';
import {taskRepeatCfgReducer} from '../../features/task-repeat-cfg/store/task-repeat-cfg.reducer';
import {Tag, TagState} from '../../features/tag/tag.model';
import {migrateProjectState} from '../../features/project/migrate-projects-state.util';
import {migrateTaskArchiveState, migrateTaskState} from '../../features/tasks/migrate-task-state.util';
import {migrateGlobalConfigState} from '../../features/config/migrate-global-config.util';
import {taskReducer} from '../../features/tasks/store/task.reducer';
import {tagReducer} from '../../features/tag/store/tag.reducer';
import {migrateTaskRepeatCfgState} from '../../features/task-repeat-cfg/migrate-task-repeat-cfg-state.util';
import {environment} from '../../../environments/environment';
import {checkFixEntityStateConsistency} from '../../util/check-fix-entity-state-consistency';
import {SimpleCounter, SimpleCounterState} from '../../features/simple-counter/simple-counter.model';
import {simpleCounterReducer} from '../../features/simple-counter/store/simple-counter.reducer';
import {from, merge, Observable, Subject} from 'rxjs';
import {concatMap, shareReplay} from 'rxjs/operators';
import {devError} from '../../util/dev-error';

@Injectable({
  providedIn: 'root',
})
export class PersistenceService {

  // handled as private but needs to be assigned before the creations
  _baseModels = [];
  _projectModels = [];

  // TODO auto generate ls keys from appDataKey where possible
  globalConfig = this._cmBase<GlobalConfigState>(LS_GLOBAL_CFG, 'globalConfig', migrateGlobalConfigState);
  reminders = this._cmBase<Reminder[]>(LS_REMINDER, 'reminders');

  project = this._cmBaseEntity<ProjectState, Project>(
    LS_PROJECT_META_LIST,
    'project',
    projectReducer,
    migrateProjectState,
  );
  tag = this._cmBaseEntity<TagState, Tag>(
    LS_TAG_STATE,
    'tag',
    tagReducer,
  );
  simpleCounter = this._cmBaseEntity<SimpleCounterState, SimpleCounter>(
    LS_SIMPLE_COUNTER_STATE,
    'simpleCounter',
    simpleCounterReducer,
  );

  // MAIN TASK MODELS
  task = this._cmBaseEntity<TaskState, Task>(
    LS_TASK_STATE,
    'task',
    taskReducer,
    migrateTaskState,
  );
  taskArchive = this._cmBaseEntity<TaskArchive, ArchiveTask>(
    LS_TASK_ARCHIVE,
    'taskArchive',
    taskReducer,
    migrateTaskArchiveState,
  );
  taskRepeatCfg = this._cmBaseEntity<TaskRepeatCfgState, TaskRepeatCfg>(
    LS_TASK_REPEAT_CFG_STATE,
    'taskRepeatCfg',
    taskRepeatCfgReducer,
    migrateTaskRepeatCfgState,
  );


  // PROJECT MODELS
  bookmark = this._cmProject<BookmarkState, Bookmark>(
    LS_BOOKMARK_STATE,
    'bookmark',
  );
  note = this._cmProject<NoteState, Note>(
    LS_NOTE_STATE,
    'note',
  );
  metric = this._cmProject<MetricState, Metric>(
    LS_METRIC_STATE,
    'metric',
  );
  improvement = this._cmProject<ImprovementState, Improvement>(
    LS_IMPROVEMENT_STATE,
    'improvement',
  );
  obstruction = this._cmProject<ObstructionState, Obstruction>(
    LS_OBSTRUCTION_STATE,
    'obstruction',
  );

  onAfterSave$: Subject<{ appDataKey: AllowedDBKeys, data: any, isDataImport: boolean, projectId?: string }> = new Subject();
  onAfterImport$: Subject<AppDataComplete> = new Subject();

  inMemoryComplete$: Observable<AppDataComplete> = merge(
    from(this.loadComplete()),
    this.onAfterImport$,
    this.onAfterSave$.pipe(
      concatMap(() => this.loadComplete()),
      // TODO maybe not necessary
      // skipWhile(complete => !isValidAppData(complete)),
    ),
  ).pipe(
    shareReplay(1),
  );

  private _inMemoryComplete: AppDataComplete;
  private _isBlockSaving = false;

  constructor(
    private _snackService: SnackService,
    private _databaseService: DatabaseService,
    private _compressionService: CompressionService,
  ) {
    // this.inMemoryComplete$.subscribe((v) => console.log('inMemoryComplete$', v));
  }


  // PROJECT ARCHIVING
  // -----------------
  async loadProjectArchive(): Promise<ProjectArchive> {
    return await this._loadFromDb({
      dbKey: 'archivedProjects',
      legacyDBKey: LS_PROJECT_ARCHIVE
    });
  }

  async saveProjectArchive(data: ProjectArchive, isDataImport = false): Promise<any> {
    return await this._saveToDb({dbKey: 'archivedProjects', data, isDataImport});
  }

  async loadArchivedProject(projectId): Promise<ProjectArchivedRelatedData> {
    const archive = await this._loadFromDb({dbKey: 'project', legacyDBKey: LS_PROJECT_ARCHIVE, projectId});
    const projectDataCompressed = archive[projectId];
    const decompressed = await this._compressionService.decompress(projectDataCompressed);
    const parsed = JSON.parse(decompressed);
    console.log(`Decompressed project, size before: ${projectDataCompressed.length}, size after: ${decompressed.length}`, parsed);
    return parsed;
  }

  async removeArchivedProject(projectId): Promise<any> {
    const archive = await this._loadFromDb({
      dbKey: 'archivedProjects',
      legacyDBKey: LS_PROJECT_ARCHIVE
    });
    delete archive[projectId];
    await this.saveProjectArchive(archive);
  }

  async saveArchivedProject(projectId, archivedProject: ProjectArchivedRelatedData) {
    const current = await this.loadProjectArchive() || {};
    const jsonStr = JSON.stringify(archivedProject);
    const compressedData = await this._compressionService.compress(jsonStr);
    console.log(`Compressed project, size before: ${jsonStr.length}, size after: ${compressedData.length}`, archivedProject);
    return this.saveProjectArchive({
      ...current,
      [projectId]: compressedData,
    });
  }

  async loadCompleteProject(projectId: string): Promise<ExportedProject> {
    const allProjects = await this.project.loadState();
    return {
      ...allProjects.entities[projectId],
      relatedModels: await this.loadAllRelatedModelDataForProject(projectId),
    };
  }

  async loadAllRelatedModelDataForProject(projectId: string): Promise<ProjectArchivedRelatedData> {
    const forProjectsData = await Promise.all(this._projectModels.map(async (modelCfg) => {
      return {
        [modelCfg.appDataKey]: await modelCfg.load(projectId),
      };
    }));
    const projectData = Object.assign({}, ...forProjectsData);
    return {
      ...projectData,
    };
  }

  async removeCompleteRelatedDataForProject(projectId: string): Promise<any> {
    await Promise.all(this._projectModels.map((modelCfg) => {
      return modelCfg.remove(projectId);
    }));
  }

  async restoreCompleteRelatedDataForProject(projectId: string, data: ProjectArchivedRelatedData): Promise<any> {
    await Promise.all(this._projectModels.map((modelCfg) => {
      return modelCfg.save(projectId, data[modelCfg.appDataKey]);
    }));
  }

  async archiveProject(projectId: string): Promise<any> {
    const projectData = await this.loadAllRelatedModelDataForProject(projectId);
    await this.saveArchivedProject(projectId, projectData);
    await this.removeCompleteRelatedDataForProject(projectId);
  }

  async unarchiveProject(projectId: string): Promise<any> {
    const projectData = await this.loadArchivedProject(projectId);
    await this.restoreCompleteRelatedDataForProject(projectId, projectData);
    await this.removeArchivedProject(projectId);
  }

  // BACKUP AND SYNC RELATED
  // -----------------------
  updateLastLocalSyncModelChange(date: number = Date.now()) {
    if (!environment || !environment.production) {
      console.log('Save Last Local Sync Model Change', date);
    }
    localStorage.setItem(LS_LAST_LOCAL_SYNC_MODEL_CHANGE, date.toString());
  }

  getLastLocalSyncModelChange(): number {
    const la = localStorage.getItem(LS_LAST_LOCAL_SYNC_MODEL_CHANGE);
    // NOTE: we need to parse because new Date('1570549698000') is "Invalid Date"
    const laParsed = Number.isNaN(Number(la))
      ? la
      : +la;
    // NOTE: to account for legacy string dates
    return new Date(laParsed).getTime();
  }

  async loadBackup(): Promise<AppDataComplete> {
    return this._loadFromDb({dbKey: LS_BACKUP, legacyDBKey: LS_BACKUP});
  }

  async saveBackup(backup?: AppDataComplete): Promise<any> {
    const data: AppDataComplete = backup || await this.loadComplete();
    return this._saveToDb({dbKey: LS_BACKUP, data, isDataImport: true});
  }

  // NOTE: not including backup
  async loadComplete(): Promise<AppDataComplete> {
    let r;
    if (!this._inMemoryComplete) {
      const projectState = await this.project.loadState();
      const pids = projectState ? projectState.ids as string[] : [DEFAULT_PROJECT_ID];
      if (!pids) {
        throw new Error('Project State is broken');
      }

      r = {
        ...(await this._loadAppDataForProjects(pids)),
        ...(await this._loadAppBaseData()),
      };
      this._inMemoryComplete = r;
    } else {
      r = this._inMemoryComplete;
    }

    return {
      ...r,
      // TODO remove legacy field
      ...({lastActiveTime: this.getLastLocalSyncModelChange()} as any),

      lastLocalSyncModelChange: this.getLastLocalSyncModelChange(),
    };
  }

  async importComplete(data: AppDataComplete) {
    console.log('IMPORT--->', data);
    this._isBlockSaving = true;

    const forBase = Promise.all(this._baseModels.map(async (modelCfg: PersistenceBaseEntityModel<any, any>) => {
      return await modelCfg.saveState(data[modelCfg.appDataKey], true);
    }));
    const forProject = Promise.all(this._projectModels.map(async (modelCfg: PersistenceForProjectModel<any, any>) => {
      if (!data[modelCfg.appDataKey]) {
        devError('No data for ' + modelCfg.appDataKey + ' - ' + data[modelCfg.appDataKey]);
        return;
      }
      return await this._saveForProjectIds(data[modelCfg.appDataKey], modelCfg.save, true);
    }));

    return await Promise.all([
      forBase,
      forProject,
    ])
      .then(() => {
        this.updateLastLocalSyncModelChange(data.lastLocalSyncModelChange);
        this._inMemoryComplete = data;
        this.onAfterImport$.next(data);
      })
      .finally(() => {
        this._isBlockSaving = false;
      });
  }

  async cleanDatabase() {
    const completeData: AppDataComplete = await this.loadComplete();
    await this._databaseService.clearDatabase();
    await this.importComplete(completeData);
  }

  async clearDatabaseExceptBackup() {
    const backup: AppDataComplete = await this.loadBackup();
    await this._databaseService.clearDatabase();
    if (backup) {
      await this.saveBackup(backup);
    }
  }

  async _loadAppBaseData(): Promise<AppBaseData> {
    const promises = this._baseModels.map(async (modelCfg) => {
      const modelState = await modelCfg.loadState();
      return {
        [modelCfg.appDataKey]: modelState || DEFAULT_APP_BASE_DATA[modelCfg.appDataKey],
      };
    });
    const baseDataArray: Partial<AppBaseData>[] = await Promise.all(promises);
    return Object.assign({}, ...baseDataArray);
  }

  // TODO maybe refactor to class?

  // ------------------
  private _cmBase<T>(
    lsKey: string,
    appDataKey: keyof AppBaseData,
    migrateFn: (state: T) => T = (v) => v,
    isSkipPush = false,
  ): PersistenceBaseModel<T> {
    const model = {
      appDataKey,
      loadState: (isSkipMigrate = false) => isSkipMigrate
        ? this._loadFromDb({dbKey: appDataKey, legacyDBKey: lsKey})
        : this._loadFromDb({dbKey: appDataKey, legacyDBKey: lsKey}).then(migrateFn),
      // In case we want to check on load
      // loadState: async (isSkipMigrate = false) => {
      //   const data = isSkipMigrate
      //     ? await this._loadFromDb(lsKey)
      //     : await this._loadFromDb(lsKey).then(migrateFn);
      //   if (data && data.ids && data.entities) {
      //     checkFixEntityStateConsistency(data, appDataKey);
      //   }
      //   return data;
      // },
      saveState: (data, isDataImport) => {
        if (data && data.ids && data.entities) {
          data = checkFixEntityStateConsistency(data, appDataKey);
        }
        return this._saveToDb({dbKey: appDataKey, data, isDataImport});
      },
    };
    if (!isSkipPush) {
      this._baseModels.push(model);
    }
    return model;
  }

  private _cmBaseEntity<S, M>(
    lsKey: string,
    appDataKey: keyof AppBaseData,
    reducerFn: (state: S, action: Action) => S,
    migrateFn: (state: S) => S = (v) => v,
  ): PersistenceBaseEntityModel<S, M> {
    const model = {
      ...this._cmBase(lsKey, appDataKey, migrateFn, true),

      getById: async (id: string): Promise<M> => {
        const state = await model.loadState() as any;
        return state && state.entities && state.entities[id] || null;
      },

      // NOTE: side effects are not executed!!!
      execAction: async (action: Action): Promise<S> => {
        const state = await model.loadState();
        const newState = reducerFn(state, action);
        await model.saveState(newState, false);
        return newState;
      },
    };

    this._baseModels.push(model);
    return model;
  }

  // TODO maybe find a way to exec effects here as well
  private _cmProject<S, M>(
    lsKey: string,
    appDataKey: keyof AppDataForProjects,
    migrateFn: (state: S, projectId: string) => S = (v) => v,
  ): PersistenceForProjectModel<S, M> {
    const model = {
      appDataKey,
      load: (projectId): Promise<S> => this._loadFromDb({
        dbKey: appDataKey,
        projectId,
        legacyDBKey: this._makeProjectKey(projectId, lsKey)
      }).then(v => migrateFn(v, projectId)),
      save: (projectId, data, isDataImport) => this._saveToDb({
        dbKey: appDataKey,
        data,
        isDataImport,
        projectId
      }),
      remove: (projectId) => this._removeFromDb({dbKey: appDataKey, projectId}),
      ent: {
        getById: async (projectId: string, id: string): Promise<M> => {
          const state = await model.load(projectId) as any;
          return state && state.entities && state.entities[id] || null;
        },
      },
    };

    this._projectModels.push(model);
    return model;
  }

  private async _loadAppDataForProjects(projectIds: string[]): Promise<AppDataForProjects> {
    const forProjectsData = await Promise.all(this._projectModels.map(async (modelCfg) => {
      const modelState = await this._loadForProjectIds(projectIds, modelCfg.load);
      return {
        [modelCfg.appDataKey]: modelState,
      };
    }));
    return Object.assign({}, ...forProjectsData);
  }

  // tslint:disable-next-line
  private async _loadForProjectIds(pids, getDataFn: Function): Promise<any> {
    return await pids.reduce(async (acc, projectId) => {
      const prevAcc = await acc;
      const dataForProject = await getDataFn(projectId);
      return {
        ...prevAcc,
        [projectId]: dataForProject
      };
    }, Promise.resolve({}));
  }

  // tslint:disable-next-line
  private async _saveForProjectIds(data: any, saveDataFn: Function, isDataImport = false) {
    const promises = [];
    Object.keys(data).forEach(projectId => {
      if (data[projectId]) {
        promises.push(saveDataFn(projectId, data[projectId], isDataImport));
      }
    });
    return await Promise.all(promises);
  }

  private _makeProjectKey(projectId, subKey, additional?) {
    return LS_PROJECT_PREFIX + projectId + '_' + subKey + (additional ? '_' + additional : '');
  }


  // DATA STORAGE INTERFACE
  // ---------------------
  private _getIDBKey(dbKey: AllowedDBKeys, projectId?: string) {
    return projectId
      ? 'p__' + projectId + '__' + dbKey
      : dbKey;
  }

  private async _saveToDb({dbKey, data, isDataImport = false, projectId}: {
    dbKey: AllowedDBKeys;
    data: any;
    projectId?: string,
    isDataImport?: boolean,
  }): Promise<any> {
    if (!this._isBlockSaving || isDataImport === true) {
      const idbKey = this._getIDBKey(dbKey, projectId);
      const r = await this._databaseService.save(idbKey, data);

      this._updateInMemory({
        projectId,
        appDataKey: dbKey,
        data
      });

      this.onAfterSave$.next({appDataKey: dbKey, data, isDataImport, projectId});

      return r;
    } else {
      console.warn('BLOCKED SAVING for ', dbKey);
      return Promise.reject('Data import currently in progress. Saving disabled');
    }
  }

  private async _removeFromDb({dbKey, isDataImport = false, projectId}: {
    dbKey: AllowedDBKeys;
    projectId?: string,
    isDataImport?: boolean,
  }): Promise<any> {
    const idbKey = this._getIDBKey(dbKey, projectId);
    if (!this._isBlockSaving || isDataImport === true) {
      return this._databaseService.remove(idbKey);
    } else {
      console.warn('BLOCKED SAVING for ', dbKey);
      return Promise.reject('Data import currently in progress. Removing disabled');
    }
  }

  private async _loadFromDb({legacyDBKey, dbKey, projectId}: {
    legacyDBKey: string,
    dbKey: AllowedDBKeys,
    projectId?: string,
  }): Promise<any> {
    const idbKey = this._getIDBKey(dbKey, projectId);
    // TODO remove legacy stuff
    return await this._databaseService.load(idbKey) || await this._databaseService.load(legacyDBKey) || undefined;
  }

  private _updateInMemory({appDataKey, projectId, data}: {
    appDataKey: AllowedDBKeys,
    projectId?: string,
    data: any
  }) {
    this._inMemoryComplete = this._extendAppDataComplete({
      complete: this._inMemoryComplete,
      projectId,
      appDataKey,
      data
    });
  }

  private _extendAppDataComplete({complete, appDataKey, projectId, data}: {
    complete: AppDataComplete,
    appDataKey: AllowedDBKeys,
    projectId?: string,
    data: any
  }): AppDataComplete {
    // console.log(appDataKey, data && data.ids && data.ids.length);
    return {
      ...complete,
      ...(
        projectId
          ? {
            [appDataKey]: {
              ...(complete[appDataKey]),
              [projectId]: data
            }
          }
          : {[appDataKey]: data}
      )
    };
  }
}
